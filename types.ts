export interface TranscriptItem {
  id: string;
  role: 'user' | 'model';
  text: string;
  image?: string; // Base64 image string
  isFinal: boolean;
  timestamp: Date;
}

export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error',
}

export interface LanguageOption {
  code: string;
  name: string;
  flag: string;
}