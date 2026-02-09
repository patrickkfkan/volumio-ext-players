import EventEmitter from "events";

export interface PlayerStatus {
  title?: string;
  artist?: string;
  album?: string;
  duration?: number; // seconds
  samplerate?: string;
  bitrate?: string;
  bitdepth?: string;
  channels?: number;
  trackType?: string;
  volume: number;
  mute: boolean;
  time: number; // seconds
  state: 'playing' | 'paused' | 'stopped';
}

export abstract class PlayerStatusProvider<S extends PlayerStatus> extends EventEmitter {

  abstract getStatus(): S;
  
  emit(eventName: 'time', time: number): boolean;
  emit(eventName: 'status', status: S): boolean;
  emit<K>(eventName: string | symbol, ...args: any[]): boolean {
    return super.emit(eventName, ...args);
  }

  on(eventName: 'time', listener: (time: number) => void): this;
  on(eventName: 'status', listener: (status: S) => void): this;
  on<K>(eventName: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(eventName, listener);
  }

  once(eventName: 'time', listener: (time: number) => void): this;
  once(eventName: 'status', listener: (status: S) => void): this;
  once<K>(eventName: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(eventName, listener);
  }


  off(eventName: 'time', listener: (time: number) => void): this;
  off(eventName: 'status', listener: (status: S) => void): this;
  off<K>(eventName: string | symbol, listener: (...args: any[]) => void): this {
      return super.off(eventName, listener);
  }
}