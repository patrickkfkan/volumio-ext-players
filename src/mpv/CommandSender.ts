import { type Socket } from "net";
import { type Logger } from "../common/ServiceContext";
import { type MPVSeekMode } from "./MPVControl";
import { type ObservableProperty } from "./MPVStatusProvider";

export interface MPVCommandSenderOptions {
  socket: Socket;
  logger: Logger;
}

const TIME_OUT = 10000;

export class MPVCommandSender {
  
  #requestId = 0;
  #socket: Socket;
  #logger: Logger;
  #pendingCommands: Record<number, { resolve: (value: any) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }> = {};

  constructor(options: MPVCommandSenderOptions) {
    this.#socket = options.socket;
    this.#logger = options.logger;
  }

  #newRequestId() {
    const id = this.#requestId;
    this.#requestId++;
    return id;
  }

  processParsedIncomingData(data: any[]) {
    for (const res of data) {
      const requestId = res['request_id'] ?? null;
      if (requestId !== null && this.#pendingCommands[requestId]) {
        const { resolve, reject, timer } = this.#pendingCommands[requestId];
        clearTimeout(timer);
        delete this.#pendingCommands[requestId];
        this.#logger.info(`Got response for command #${requestId}: ${JSON.stringify(res)}`);
        if (res['error'] === 'success') {
          resolve(res['data']);
        }
        if (res['error']) {
          reject(Error(res['error']));
        }
        reject(Error(`Unknown error with command #${requestId}`));
      }
    }
  }

  send(command: 'loadfile', location: string, loadType: 'replace' | 'append' | 'append-play' | 'insert-next'): Promise<void>;
  send(command: 'stop'): Promise<void>;
  send(command: 'seek', position: number, mode: MPVSeekMode): Promise<void>;
  send(command: 'observe_property', susbcriptionId: number, property: ObservableProperty): Promise<void>;
  send(command: 'unobserve_property', susbcriptionId: number): Promise<void>;
  send(command: 'set_property', property: 'loop-file', times: 'inf' | 'no' | number): Promise<void>;
  send(command: 'get_property', property: 'volume' | 'time-pos'): Promise<number>;
  send(command: 'set_property', property: 'volume' | 'time-pos', value: number): Promise<void>;
  send(command: 'get_property', property: 'pause' | 'idle-active'): Promise<boolean>;
  send(command: 'set_property', property: 'pause', value: boolean): Promise<void>;
  send(command: 'quit'): Promise<void>;
  send(command: string, ...params: unknown[]) {
    const requestId = this.#newRequestId();
    const cmd = {
      command: [command, ...params],
      request_id: requestId
    }
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        delete this.#pendingCommands[requestId];
        return reject(Error('Command timeout'));
      }, TIME_OUT);
      const cmdStr = JSON.stringify(cmd);
      this.#logger.info(`Send IPC command: ${cmdStr}`);
      this.#socket.write(cmdStr + '\n');
      this.#pendingCommands[requestId] = { resolve, reject, timer };
    });
  }
}