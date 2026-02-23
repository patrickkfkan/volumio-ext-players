import { type ChildProcess, spawn } from "child_process";
import { randomUUID } from "crypto";
import { EOL } from "os";
import pidtree from 'pidtree';
import yargs from 'yargs';
import path from "path";
import { Socket } from "net";
import { MPVControl } from "./MPVControl";
import { MPVStatusProvider, type MPVStatus } from "./MPVStatusProvider";
import { MPVCommandSender } from "./CommandSender";
import { validateVolumioContext } from "../common/VolumioContext";
import { type ServiceContext, type Logger } from "../common/ServiceContext";
import { type TrackInfo, VolumioStateManager } from "../common/VolumioStateManager";
import { MPVHelper } from "./MPVHelper";
import { getErrorMessage } from "../common/Util";
import { existsSync, unlinkSync } from "fs";
import { DeferredPromise } from "@open-draft/deferred-promise";
import { Service } from "../common/Service";

export interface MPVServiceContext extends ServiceContext {
  mpvArgs?: string[];
}

export type UnvalidatedMPVServiceContext = Omit<MPVServiceContext, 'volumio'> & {
  volumio?: {
    commandRouter: unknown;
    statemachine: unknown;
    mpdPlugin: unknown;
  }
};

export class MPVService extends Service<MPVStatus> {

  #context: MPVServiceContext;
  #process: ChildProcess | null = null;
  #isRunning = false;
  #quitPromise: DeferredPromise<void> | null = null;
  #socketPath: string | null = null;
  #socket: Socket | null = null;
  #command: MPVCommandSender | null = null;
  #control: MPVControl | null = null;
  #statusProvider: MPVStatusProvider | null = null;
  #manager: VolumioStateManager<MPVStatus> | null = null;
  #logger: Logger;

  #incomingSocketDataHandler: (data: Buffer) => void;
  #statusEventHandler: (status: MPVStatus) => void;

  constructor(context: UnvalidatedMPVServiceContext) {
    super();
    this.#logger = this.#wrapLogger();

    if (!context.volumio) {
      this.#context = {
        ...context,
        volumio: undefined
      };
    }
    else if (validateVolumioContext(context.volumio)) {
      this.#context = {
        ...context,
        volumio: context.volumio
      };
    }
    else {
      this.#logger.error('Failed to validate Volumio context. No state management will be available.');
      this.#context = {
        ...context,
        volumio: undefined
      }
    }
    this.#incomingSocketDataHandler = (data) => this.#handleIncomingSocketData(data);
    this.#statusEventHandler = (status) => this.#forwardStatusEvent(status);
  }

  #wrapLogger() {
    const logMsg = (msg: string) => {
      const pid = this.#process ? this.#process.pid : null;
      const pidStr = pid ? ` (PID: ${pid})` : null;
      return `[${this.#context.serviceName}] [mpv]${pidStr || ''} ${msg}`;
    }
    return {
      info: (msg: string) => this.#context.logger.info(logMsg(msg)),
      warn: (msg: string) => this.#context.logger.warn(logMsg(msg)),
      error: (msg: string) => this.#context.logger.error(logMsg(msg)),
    }
  }

  start() {
    return new Promise<void>((resolve, reject) => {
      this.#socketPath = path.resolve('/tmp', `volumio_mpv_socket_${randomUUID()}`);
      const sArgs = [
        '--idle',
        '--no-video',
        `--input-ipc-server="${this.#socketPath}"`,
        '--term-status-msg=""',
      ];
      if (this.#context.mpvArgs) {
        sArgs.push(...this.#context.mpvArgs);
      }
      const customArgs = this.#context.mpvArgs ?
        yargs(this.#context.mpvArgs)
          .option("audio-device", { type: "string" })
          .parseSync()
        : null; 
      if (!customArgs || !customArgs['audio-device']) {
        sArgs.push(`--audio-device="alsa/volumio"`);
      }
      const s = spawn('mpv',
        sArgs,
        {
          uid: 1000,
          gid: 1000,
          shell: true
        }
      );
      let lastError: Error | null = null;
      const preStartErrors: string[] = [];

      this.#logger.info('mpv process spawned');

      const rejectIfNotRunning = () => {
        if (!this.#isRunning) {
          if (lastError) {
            reject(lastError);
          }
          else if (preStartErrors.length > 0) {
            reject(Error(preStartErrors.join(EOL)));
          }
          else {
            reject(Error('Unknown cause'));
          }
        }
      }

      this.#createSocket(this.#socketPath).then((socket) => {
        this.#isRunning = true;
        this.#logger.info(`Started (IPC socket: ${this.#socketPath})`);
        this.#socket = socket;
        this.#command = new MPVCommandSender({
          socket,
          logger: this.#logger
        });
        this.#statusProvider = new MPVStatusProvider({
          commandSender: this.#command,
          logger: this.#logger
        });
        this.#control = new MPVControl({
          context: this.#context,
          statusProvider: this.#statusProvider,
          commandSender: this.#command
        });
        this.#manager = new VolumioStateManager({
          context: this.#context,
          control: this.#control,
          statusProvider: this.#statusProvider,
          logger: this.#logger
        });
      })
        .then(() => {
          this.#socket!.on('data', this.#incomingSocketDataHandler);
        })
        .then(() => this.#statusProvider!.on('status', this.#statusEventHandler))
        .then(() => this.#statusProvider!.start())
        .then(() => resolve())
        .catch((error: unknown) => {
          preStartErrors.push(getErrorMessage(error));
          return rejectIfNotRunning();
        });

      s.stderr.on('data', (msg) => {
        const _msg = msg.toString() as string;
        this.#logger.info(_msg);
        if (!this.#isRunning) {
          preStartErrors.push(_msg);
        }
      });

      s.stdout.on('data', (msg) => {
        const _msg = msg.toString();
        this.#logger.info(_msg);
      });

      s.stderr.on('error', (err) => {
        this.#logger.error(`stderr error: ${err.message}`);
      });

      s.stdout.on('error', (err) => {
        this.#logger.error(`stdout error: ${err.message}`);
      });

      s.on('close', (code, signal) => {
        void (async () => {
          const emitCode = this.#quitPromise ? 0 : -1;
          await this.#statusProvider!.reset(true);
          if (!this.#quitPromise && this.isActive()) {
            // If we reach here, mpv has ended unexpectedly.
            // Important - stops Volumio from automatically advancing to next track
            this.#context.volumio!.statemachine.currentStatus = 'stop';
            this.#manager!.unsetVolatile();
          }
          await this.#reset();
          this.#logger.info(`Process closed - code: ${code}, signal: ${signal}`);
          rejectIfNotRunning();
          this.emit('close', emitCode, signal);
          if (this.#quitPromise) {
            this.#quitPromise.resolve();
          }
        })();
      });

      s.on('error', (err) => {
        this.#logger.error(`Process error: ${err.message}`);
        lastError = err;
      });

      this.#process = s;
    });
  }

  #handleIncomingSocketData(data: Buffer) {
    const { parsed, errors } = MPVHelper.parseJsonIPCData(data.toString());
    if (errors.length > 0) {
      for (const error of errors) {
        this.#logger.error(`Failed to parse incoming data: ${error}`);
      }
    }
    this.#command?.processParsedIncomingData(parsed);
    this.#statusProvider?.processParsedIncomingData(parsed);
  };

  #forwardStatusEvent(status: MPVStatus) {
    this.emit('status', status);
  };

  #createSocket(socketPath: string) {
    const interval = 300;
    const timeout = 10000;
    const startTime = Date.now();
    const client = new Socket();

    return new Promise<Socket>((resolve, reject) => {
      const tryConnect = () => {
        client.connect(socketPath, () => {
          resolve(client);
        });
      };
      client.on('error', (error) => {
        const isTimedOut = Date.now() - startTime > timeout;
        if (isTimedOut) {
          return reject(Error(`Socket error: ${getErrorMessage(error)}`));
        }
        setTimeout(tryConnect, interval);
      });
      tryConnect();
    });
  }

  async quit() {
    if (this.#quitPromise) {
      return this.#quitPromise;
    }
    if (!this.#process) {
      this.#logger.warn('Cannot quit - no process exists');
      return;
    }
    if (!this.#command || !this.#socket) {
      this.#logger.warn('Cannot quit - CommandSender or socket not initialized');
      return;
    }
    await this.stop();

    const command = this.#command;
    const socket = this.#socket;
    const process = this.#process;
    const logger = this.#logger;
    const deferred = new DeferredPromise<void>();

    const forceCloseTimer = setTimeout(() => {
      if (!socket.destroyed && this.#process) {
        logger.warn('Timeout during quit - kill process instead');
        void (async () => {
          await this.#kill();
          socket.destroy();
        })();
      }
    }, 10000);

    socket.once('end', () => {
      socket.destroy();
    });

    process.once('close', () => {
      clearTimeout(forceCloseTimer);
    });

    void (async () => {
      await command.send('quit');
    })();
    
    this.#quitPromise = deferred.finally(() => {
      this.#quitPromise = null;
    });

    return this.#quitPromise;
  }

  async #kill() {
    if (!this.#isRunning || !this.#process) {
      this.#logger.warn('Cannot kill process that is not running');
      return;
    }
    const proc = this.#process;
    return new Promise<void>((resolve) => {
      void (async () => {
        let tree: number[];
        try {
          if (proc.pid === undefined) {
            throw Error('proc.pid is undefined');
          }
          tree = await pidtree(proc.pid, { root: true });
        }
        catch (error) {
          this.#logger.warn(`Failed to obtain PID tree for killing - resolving anyway: ${getErrorMessage(error)}`);
          await this.#reset();
          resolve();
          return;
        }
        let cleanKill = true;
        let pid = tree.shift();
        while (pid) {
          try {
            if (this.#pidExists(pid)) {
              this.#logger.info(`Killing PID ${pid}`);
              this.#sigkill(pid);
            }
          }
          catch (error) {
            this.#logger.warn(`Error killing PID ${pid} - proceeding anyway: ${getErrorMessage(error)}`);
            cleanKill = false;
          }
          pid = tree.shift();
        }
        if (cleanKill) {
          this.#logger.info('Process killed');
        }
        else {
          this.#logger.warn('Process killed uncleanly - there may be zombie processes left behind.');
        }
        resolve();
      })();
    });
  }

  #sigkill(pid: number) {
    process.kill(pid, 'SIGKILL');
  }

  #pidExists(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    }
    catch (error) {
      return false;
    }
  }

  async #reset() {
    if (this.#manager) {
      this.#manager.dispose();
      this.#manager = null;
    }
    if (this.#statusProvider) {
      this.#statusProvider.off('status', this.#statusEventHandler);
      try {
        await this.#statusProvider.reset();
      }
      catch (_) {
        // Do nothing
      }
      this.#statusProvider = null;
    }
    if (this.#socket) {
      this.#socket.off('data', this.#incomingSocketDataHandler);
      if (!this.#socket.destroyed) {
        this.#socket.destroy();
      }
      this.#socket = null;
    }
    if (this.#socketPath && existsSync(this.#socketPath)) {
      try {
        unlinkSync(this.#socketPath);
      }
      catch (error: unknown) {
        this.#logger.error(`Failed to clean up socket file "${this.#socketPath}": ${getErrorMessage(error)}`);
      }
    }
    if (this.#process) {
      this.#process.stdout?.removeAllListeners();
      this.#process.stderr?.removeAllListeners();
      this.#process.removeAllListeners();
      this.#process = null;
    }
    this.#control = null;
    this.#isRunning = false;
  }

  #assertReady() {
    if (!this.#control) {
      throw Error('MPVControl is not initialized');
    }
    if (!this.#manager) {
      throw Error('VolumioStateManager is not initialized');
    }
    return {
      control: this.#control,
      manager: this.#manager
    };
  }

  isActive() {
    if (!this.#manager || this.#quitPromise) {
      return false;
    }
    return this.#manager.isCurrentServiceAndVolatile() &&
      this.getStatus()?.state !== 'stopped';
  }

  getStatus() {
    if (!this.#statusProvider) {
      return null;
    }
    return this.#statusProvider.getStatus();
  }

  async play(track: TrackInfo, start = 0) {
    const { control, manager } = this.#assertReady();
    await manager.prepareForPlayback(track);
    return await control.playFile(track.streamUrl, start);
  }

  pause() {
    const { control } = this.#assertReady();
    return control.pause();
  }

  stop() {
    const { control } = this.#assertReady();
    return control.stop();
  }

  resume() {
    const { control } = this.#assertReady();
    return control.play();
  }

  next() {
    const { control } = this.#assertReady();
    return control.next();
  }

  previous() {
    const { control } = this.#assertReady();
    return control.previous();
  }

  setRandom(value: boolean) {
    const { manager } = this.#assertReady();
    return manager.setRandom(value);
  }

  async setRepeat(value: boolean, repeatSingle: boolean) {
    const { manager } = this.#assertReady();
    return await manager.setRepeat(value, repeatSingle);
  }

  seek(position: number) {
    const { control } = this.#assertReady();
    return control.seek(position);
  }
}