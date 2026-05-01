export interface Conversation {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  is_deleted_on_web?: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: number;
  parent_id?: string;
}

export interface ElectronAPI {
  invoke: (channel: string, ...args: any[]) => Promise<any>;
  onCacheProgress?: (func: (...args: any[]) => void) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
