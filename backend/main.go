// Command backend serves the MecroTube HTTP API backed by SQLite.
//
// Routes:
//
//	GET    /api/transit      - public transit data
//	PUT    /api/transit      - replace transit data (requires admin session)
//	POST   /api/admin-auth   - log in with the admin password, sets session cookie
//	GET    /api/admin-auth   - report whether the caller has a valid session
//	DELETE /api/admin-auth   - log out, clears session cookie
//
// The admin password is read from data/admin-password.txt (created with the
// default "changeme" on first run). Transit data is stored in data/transit.db.
package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

const (
	defaultPort   = "4322"
	sessionCookie = "admin_session"
	sessionTTL    = 24 * time.Hour
	defaultPass   = "changeme"
	maxBodyBytes  = 10 << 20 // 10 MiB
)

// ---------- Transit data model ----------

type Stop struct {
	ID     string  `json:"id"`
	NameEn string  `json:"nameEn"`
	NameAr string  `json:"nameAr"`
	Lat    float64 `json:"lat"`
	Lng    float64 `json:"lng"`
}

type Line struct {
	ID      string   `json:"id"`
	NameEn  string   `json:"nameEn"`
	NameAr  string   `json:"nameAr"`
	Color   string   `json:"color"`
	Loop    bool     `json:"loop"`
	StopIDs []string `json:"stopIds"`
}

type TransitData struct {
	Stops []Stop `json:"stops"`
	Lines []Line `json:"lines"`
}

// valid reports whether the decoded data has the expected shape. JSON decoding
// into typed structs already enforces most of it; this guards against missing
// arrays and null entries.
func (d *TransitData) valid() bool {
	if d.Stops == nil || d.Lines == nil {
		return false
	}
	for _, s := range d.Stops {
		if s.ID == "" {
			return false
		}
	}
	for _, l := range d.Lines {
		if l.ID == "" || l.Color == "" || l.StopIDs == nil {
			return false
		}
	}
	return true
}

// ---------- Storage ----------

type Store struct {
	db *sql.DB
	mu sync.Mutex
}

func NewStore(dbPath string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", dbPath+"?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	// SQLite is happiest with a single writer.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS app_state (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		payload TEXT NOT NULL
	)`); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Get() TransitData {
	s.mu.Lock()
	defer s.mu.Unlock()
	var payload string
	err := s.db.QueryRow(`SELECT payload FROM app_state WHERE id = 1`).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		return TransitData{Stops: []Stop{}, Lines: []Line{}}
	}
	if err != nil {
		log.Printf("read transit data: %v", err)
		return TransitData{Stops: []Stop{}, Lines: []Line{}}
	}
	var data TransitData
	if err := json.Unmarshal([]byte(payload), &data); err != nil || !data.valid() {
		log.Printf("parse transit data: %v", err)
		return TransitData{Stops: []Stop{}, Lines: []Line{}}
	}
	return data
}

func (s *Store) Put(data *TransitData) error {
	payload, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.db.Exec(`INSERT INTO app_state (id, payload) VALUES (1, ?)
		ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`, string(payload))
	return err
}

// ---------- Sessions ----------

type Sessions struct {
	mu      sync.Mutex
	entries map[string]time.Time // token -> expiry
}

func NewSessions() *Sessions {
	return &Sessions{entries: map[string]time.Time{}}
}

func (s *Sessions) Create() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	token := hex.EncodeToString(buf)
	s.mu.Lock()
	s.entries[token] = time.Now().Add(sessionTTL)
	s.mu.Unlock()
	return token
}

func (s *Sessions) Valid(token string) bool {
	if token == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	expiry, ok := s.entries[token]
	if !ok {
		return false
	}
	if time.Now().After(expiry) {
		delete(s.entries, token)
		return false
	}
	return true
}

func (s *Sessions) Delete(token string) {
	s.mu.Lock()
	delete(s.entries, token)
	s.mu.Unlock()
}

// ---------- Admin password ----------

func readPassword(path string) string {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err == nil {
			if err := os.WriteFile(path, []byte(defaultPass+"\n"), 0o600); err == nil {
				log.Printf("created default admin password file at %s - change it before deploying", path)
			}
		}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		log.Printf("read admin password file: %v", err)
		return ""
	}
	return strings.TrimSpace(string(b))
}

// ---------- HTTP handlers ----------

type Server struct {
	store      *Store
	sessions   *Sessions
	passwdPath string
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func (s *Server) authenticated(r *http.Request) bool {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return false
	}
	return s.sessions.Valid(c.Value)
}

func (s *Server) handleTransit(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.store.Get())
	case http.MethodPut:
		if !s.authenticated(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Unauthorized"})
			return
		}
		var data TransitData
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
		if err := dec.Decode(&data); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid JSON body"})
			return
		}
		if !data.valid() {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid transit data"})
			return
		}
		if err := s.store.Put(&data); err != nil {
			log.Printf("write transit data: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to save"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		w.Header().Set("Allow", "GET, PUT")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
	}
}

func (s *Server) handleAdminAuth(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]bool{"authenticated": s.authenticated(r)})
	case http.MethodPost:

		var password, to string
		to = "/admin"
		ct := r.Header.Get("Content-Type")
		if strings.Contains(ct, "application/json") {
			var body struct {
				Password string `json:"password"`
				To       string `json:"to"`
			}
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request"})
				return
			}
			password, to = body.Password, body.To
		} else {
			if err := r.ParseForm(); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request"})
				return
			}
			password = r.FormValue("password")
			if v := r.FormValue("to"); v != "" {
				to = v
			}
		}
		expected := readPassword(s.passwdPath)

		log.Printf("hi")
		log.Printf(password)
		log.Printf(expected)

		if expected == "" || password != expected {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid password"})
			return
		}
		if !strings.HasPrefix(to, "/") {
			to = "/admin"
		}
		token := s.sessions.Create()
		http.SetCookie(w, &http.Cookie{
			Name:     sessionCookie,
			Value:    token,
			Path:     "/",
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			MaxAge:   int(sessionTTL.Seconds()),
		})
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "to": to})
	case http.MethodDelete:
		if c, err := r.Cookie(sessionCookie); err == nil {
			s.sessions.Delete(c.Value)
		}
		http.SetCookie(w, &http.Cookie{
			Name:     sessionCookie,
			Value:    "",
			Path:     "/",
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			MaxAge:   -1,
		})
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		w.Header().Set("Allow", "GET, POST, DELETE")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "Method not allowed"})
	}
}

func main() {
	dataDir := envOr("DATA_DIR", "data")
	store, err := NewStore(filepath.Join(dataDir, "transit.db"))
	if err != nil {
		log.Fatalf("open database: %v", err)
	}

	srv := &Server{
		store:      store,
		sessions:   NewSessions(),
		passwdPath: filepath.Join(dataDir, "admin-password.txt"),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/transit", srv.handleTransit)
	mux.HandleFunc("/api/admin-auth", srv.handleAdminAuth)

	port := envOr("PORT", defaultPort)
	addr := "127.0.0.1:" + port
	fmt.Printf("MecroTube API listening on http://%s\n", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
