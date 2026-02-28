import {
  type ChildProcess,
  spawn,
  type SpawnOptionsWithoutStdio
} from 'child_process';
import { randomUUID } from 'crypto';
import { EOL } from 'os';
import portfinder from 'portfinder';
import pidtree from 'pidtree';
import * as VLC from 'vlc-client';
import { type ServiceContext, type Logger } from '../common/ServiceContext';
import {
  type TrackInfo,
  VolumioStateManager
} from '../common/VolumioStateManager';
import { type VLCStatus, VLCStatusProvider } from './VLCStatusProvider';
import { VLCControl } from './VLCControl';
import { validateVolumioContext } from '../common/VolumioContext';
import yargs from 'yargs';
import { getErrorMessage } from '../common/Util';
import { DeferredPromise } from '@open-draft/deferred-promise';
import { Service } from '../common/Service';

export interface VLCServiceContext extends ServiceContext {
  vlcArgs?: string[];
  spawnOptions?: Omit<SpawnOptionsWithoutStdio, 'uid' | 'gid'> & {
    /**
     * Set to `null` for default uid
     */
    uid?: number | null;
    /**
     * Set to `null` for default gid
     */
    gid?: number | null;
  };
}

export class VLCService extends Service<VLCStatus> {
  #context: VLCServiceContext;
  #process: ChildProcess | null = null;
  #isRunning = false;
  #quitPromise: DeferredPromise<void> | null = null;
  #control: VLCControl | null = null;
  #statusProvider: VLCStatusProvider | null = null;
  #manager: VolumioStateManager<VLCStatus> | null = null;
  #logger: Logger;
  #client: VLC.Client | null = null;
  #statusEventHandler: (status: VLCStatus) => void;

  constructor(context: VLCServiceContext) {
    super();
    this.#logger = this.#wrapLogger();

    if (!context.volumio) {
      this.#context = {
        ...context,
        volumio: undefined
      };
    } else if (validateVolumioContext(context.volumio)) {
      this.#context = {
        ...context,
        volumio: context.volumio
      };
    } else {
      this.#logger.error(
        'Failed to validate Volumio context. No state management will be available.'
      );
      this.#context = {
        ...context,
        volumio: undefined
      };
    }
    this.#statusEventHandler = (status) => this.#forwardStatusEvent(status);
  }

  #wrapLogger() {
    const logMsg = (msg: string) => {
      const pid = this.#process ? this.#process.pid : null;
      const pidStr = pid ? ` (PID: ${pid})` : null;
      return `[${this.#context.serviceName}] [vlc]${pidStr || ''} ${msg}`;
    };
    return {
      info: (msg: string) => this.#context.logger.info(logMsg(msg)),
      warn: (msg: string) => this.#context.logger.warn(logMsg(msg)),
      error: (msg: string) => this.#context.logger.error(logMsg(msg))
    };
  }

  start() {
    return new Promise<void>((resolve, reject) => {
      void (async () => {
        const port = await portfinder.getPortPromise({
          host: 'localhost',
          port: 10000
        });
        const sArgs = [
          '--novideo',
          '--extraintf',
          'http',
          '--http-port',
          port.toString()
        ];
        if (this.#context.vlcArgs) {
          sArgs.push(...this.#context.vlcArgs);
        }
        const customArgs =
          this.#context.vlcArgs ?
            yargs(this.#context.vlcArgs)
              .option('aout', { type: 'string' })
              .option('alsa-audio-device', { type: 'string' })
              .option('http-password', { type: 'string' })
              .parseSync()
          : null;
        if (!customArgs || customArgs['aout']) {
          sArgs.push('--aout', 'alsa');
        }
        if (!customArgs || !customArgs['alsa-audio-device']) {
          sArgs.push('--alsa-audio-device', 'volumio');
        }
        let pw = randomUUID().replaceAll('-', '').slice(0, 12);
        if (customArgs && customArgs['http-password']) {
          pw = customArgs['http-password'];
        } else {
          sArgs.push('--http-password', pw);
        }
        const uidOpt = this.#context.spawnOptions?.uid;
        const uid =
          typeof uidOpt === 'number' ? uidOpt
          : uidOpt === null ? undefined
          : 1000;
        const gidOpt = this.#context.spawnOptions?.gid;
        const gid =
          typeof gidOpt === 'number' ? gidOpt
          : gidOpt === null ? undefined
          : 1000;
        const s = spawn('cvlc', sArgs, {
          ...this.#context.spawnOptions,
          uid,
          gid,
          shell: this.#context.spawnOptions?.shell ?? true
        });
        let lastError: Error | null = null;
        const preStartErrors: string[] = [];

        this.#logger.info('cvlc process spawned');

        const rejectIfNotRunning = () => {
          if (!this.#isRunning) {
            if (lastError) {
              reject(lastError);
            } else if (preStartErrors.length > 0) {
              reject(Error(preStartErrors.join(EOL)));
            } else {
              reject(Error('Unknown cause'));
            }
          }
        };

        this.#resolveOnStart(port, pw)
          .then(() => {
            this.#isRunning = true;
            this.#logger.info(`Started and responding on port ${port}`);
            this.#client = new VLC.Client({
              ip: 'localhost',
              port: port,
              password: pw
            });
            this.#statusProvider = new VLCStatusProvider({
              client: this.#client,
              logger: this.#logger
            });
            this.#control = new VLCControl({
              context: this.#context,
              client: this.#client,
              statusProvider: this.#statusProvider
            });
            this.#manager = new VolumioStateManager({
              context: this.#context,
              control: this.#control,
              statusProvider: this.#statusProvider,
              logger: this.#logger
            });
          })
          .then(() =>
            this.#statusProvider!.on('status', this.#statusEventHandler)
          )
          .then(() => this.#statusProvider!.startPolling())
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
          const emitCode = this.#quitPromise ? 0 : -1;
          if (!this.#quitPromise && this.isActive()) {
            // If we reach here, VLC has ended unexpectedly.
            this.#statusProvider!.reset();
            // Important - stops Volumio from automatically advancing to next track
            this.#context.volumio!.statemachine.currentStatus = 'stop';
            this.#manager!.unsetVolatile();
          }
          this.#reset();
          this.#logger.info(
            `Process closed - code: ${code}, signal: ${signal}`
          );
          rejectIfNotRunning();
          this.emit('close', emitCode, signal);
          if (this.#quitPromise) {
            this.#quitPromise.resolve();
          }
        });

        s.on('error', (err) => {
          this.#logger.error(`Process error: ${err.message}`);
          lastError = err;
        });

        this.#process = s;
      })();
    });
  }

  #resolveOnStart(port: number, pw: string) {
    const interval = 300;
    const timeout = 10000;
    const startTime = Date.now();
    const token = btoa(`:${pw}`);
    const check = async (resolve: () => void, reject: (err: Error) => void) => {
      const isTimedOut = Date.now() - startTime > timeout;
      try {
        const res = await fetch(
          `http://localhost:${port}/requests/status.json`,
          {
            headers: {
              Authorization: `Basic ${token}`
            }
          }
        );
        if (res.ok) {
          resolve();
        } else if (isTimedOut) {
          reject(Error('Timeout waiting for VLC to respond'));
        } else {
          setTimeout(() => void check(resolve, reject), interval);
        }
      } catch (error) {
        if (isTimedOut) {
          return reject(
            Error(`Failed to fetch VLC status: ${getErrorMessage(error)}`)
          );
        }
        setTimeout(() => void check(resolve, reject), interval);
      }
    };

    return new Promise<void>((resolve, reject) => {
      void check(resolve, reject);
    });
  }

  #forwardStatusEvent(status: VLCStatus) {
    this.emit('status', status);
  }

  async quit() {
    if (this.#quitPromise) {
      return this.#quitPromise;
    }
    if (!this.#isRunning || !this.#process) {
      this.#logger.warn('Cannot kill process that is not running');
      return;
    }

    await this.stop();
    this.#statusProvider?.stopPolling();

    const proc = this.#process;
    let tree: number[];
    try {
      if (proc.pid === undefined) {
        throw Error('proc.pid is undefined');
      }
      tree = await pidtree(proc.pid, { root: true });
    } catch (error) {
      this.#logger.warn(
        `Failed to obtain PID tree for killing - resolving anyway: ${getErrorMessage(error)}`
      );
      this.#reset();
      return Promise.resolve();
    }

    const deferred = new DeferredPromise<void>();

    let cleanKill = true;
    let pid = tree.shift();
    while (pid) {
      try {
        if (this.#pidExists(pid)) {
          this.#logger.info(`Killing PID ${pid}`);
          this.#sigkill(pid);
        }
      } catch (error) {
        this.#logger.warn(
          `Error killing PID ${pid} - proceeding anyway: ${getErrorMessage(error)}`
        );
        cleanKill = false;
      }
      pid = tree.shift();
    }
    if (cleanKill) {
      this.#logger.info('Process killed');
    } else {
      this.#logger.warn(
        'Process killed uncleanly - there may be zombie processes left behind.'
      );
    }

    this.#quitPromise = deferred.finally(() => {
      this.#quitPromise = null;
    });

    return this.#quitPromise;
  }

  #sigkill(pid: number) {
    process.kill(pid, 'SIGKILL');
  }

  #pidExists(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  #reset() {
    if (this.#manager) {
      this.#manager.dispose();
      this.#manager = null;
    }
    if (this.#process) {
      this.#process.stdout?.removeAllListeners();
      this.#process.stderr?.removeAllListeners();
      this.#process.removeAllListeners();
      this.#process = null;
    }
    if (this.#statusProvider) {
      this.#statusProvider.off('status', this.#statusEventHandler);
      this.#statusProvider.stopPolling();
      this.#statusProvider = null;
    }
    this.#control = null;
    this.#client = null;
    this.#isRunning = false;
  }

  #assertReady() {
    if (!this.#control) {
      throw Error('VLCControl is not initialized');
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
    return (
      this.#manager.isCurrentServiceAndVolatile() &&
      this.getStatus()?.state !== 'stopped'
    );
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

  pushState() {
    if (!this.#statusProvider) {
      return;
    }
    this.#statusProvider.emit('status', this.#statusProvider.getStatus());
  }
}
