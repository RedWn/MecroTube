export interface Stop {
  id: string;
  nameEn: string;
  nameAr: string;
  lat: number;
  lng: number;
}

export interface TransitLine {
  id: string;
  nameEn: string;
  nameAr: string;
  color: string;
  loop: boolean;
  stopIds: string[];
}

export interface TransitData {
  stops: Stop[];
  lines: TransitLine[];
}

export type Locale = 'en' | 'ar';
