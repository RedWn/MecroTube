import type { TransitData } from './types';

// Approximate real-world coordinates for Damascus neighborhoods & landmarks.
// This is illustrative sample data, not an official transit plan.
export const sampleData: TransitData = {
  stops: [
    { id: 'dummar', nameEn: 'Dummar', nameAr: 'دمر', lat: 33.5364, lng: 36.2367 },
    { id: 'mezzeh', nameEn: 'Mezzeh', nameAr: 'المزة', lat: 33.5017, lng: 36.2489 },
    { id: 'kafrsousa', nameEn: 'Kafr Sousa', nameAr: 'كفرسوسة', lat: 33.4886, lng: 36.2617 },
    { id: 'hejaz', nameEn: 'Hejaz Station', nameAr: 'محطة الحجاز', lat: 33.5117, lng: 36.2977 },
    { id: 'marjeh', nameEn: 'Marjeh Square', nameAr: 'ساحة المرجة', lat: 33.5124, lng: 36.3009 },
    { id: 'babtouma', nameEn: 'Bab Touma', nameAr: 'باب توما', lat: 33.5136, lng: 36.3138 },
    { id: 'jobar', nameEn: 'Jobar', nameAr: 'جوبر', lat: 33.5267, lng: 36.3253 },
    { id: 'abbasiyyin', nameEn: 'Abbasiyyin Square', nameAr: 'ساحة العباسيين', lat: 33.5306, lng: 36.3244 },
    { id: 'barzeh', nameEn: 'Barzeh', nameAr: 'برزة', lat: 33.5514, lng: 36.3181 },
    { id: 'ruknaldin', nameEn: 'Rukn al-Din', nameAr: 'ركن الدين', lat: 33.5372, lng: 36.2989 },
    { id: 'qassaa', nameEn: 'Qassaa', nameAr: 'القصاع', lat: 33.5225, lng: 36.3097 },
    { id: 'almidan', nameEn: 'Al-Midan', nameAr: 'الميدان', lat: 33.4917, lng: 36.2889 },
    { id: 'tishreen', nameEn: 'Tishreen', nameAr: 'تشرين', lat: 33.4972, lng: 36.2925 },
    { id: 'umayyad', nameEn: 'Umayyad Mosque', nameAr: 'الجامع الأموي', lat: 33.5117, lng: 36.3063 },
    { id: 'babsharqi', nameEn: 'Bab Sharqi', nameAr: 'باب شرقي', lat: 33.5111, lng: 36.3168 },
    { id: 'babkisan', nameEn: 'Bab Kisan', nameAr: 'باب كيسان', lat: 33.5074, lng: 36.3122 },
    { id: 'babsaghir', nameEn: 'Bab al-Saghir', nameAr: 'باب الصغير', lat: 33.5074, lng: 36.3072 },
    { id: 'hamidiyah', nameEn: 'Souq Al-Hamidiyah', nameAr: 'سوق الحميدية', lat: 33.5114, lng: 36.305 },
  ],
  lines: [
    {
      id: 'barada',
      nameEn: 'Barada Line',
      nameAr: 'خط بردى',
      color: '#0019A8',
      loop: false,
      stopIds: ['dummar', 'mezzeh', 'kafrsousa', 'hejaz', 'marjeh', 'babtouma', 'jobar', 'abbasiyyin'],
    },
    {
      id: 'qasioun',
      nameEn: 'Qasioun Line',
      nameAr: 'خط قاسيون',
      color: '#DA291C',
      loop: false,
      stopIds: ['barzeh', 'ruknaldin', 'qassaa', 'marjeh', 'almidan', 'tishreen'],
    },
    {
      id: 'oldcity',
      nameEn: 'Old City Loop',
      nameAr: 'حلقة المدينة القديمة',
      color: '#00782A',
      loop: true,
      stopIds: ['umayyad', 'babtouma', 'babsharqi', 'babkisan', 'babsaghir', 'hamidiyah'],
    },
  ],
};
