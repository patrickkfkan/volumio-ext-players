import _ from "lodash";
import { type VolumioState } from "./VolumioStateManager";

export interface StateMachine {
  currentStatus: 'play' | 'pause' | 'stop';
  currentSeek: number;
  currentPosition: number;
  getNextIndex: () => number;
  stopPlaybackTimer: () => void;
  updateTrackBlock: () => any;
  play: () => any;
  randomQueue: {
    prev: () => number;
  }
  currentRepeat: boolean;
  currentRepeatSingleSong: boolean;
  currentRandom: boolean;
  currentVolume: number | null;
  currentDbVolume: number | null;
  currentMute: boolean;
  currentDisableVolumeControl: boolean;
  isVolatile: boolean;

  volatileState?: {
    seek: number;
  }

  unSetVolatile: () => void;
  setVolatile: (params: { service: string; callback: () => void; }) => void;
  setConsumeUpdateService: (serviceName?: string) => void;
}

export interface CommandRouter {
  servicePushState: (state: VolumioState, serviceName: string) => void;
  volumioGetState: () => { service: string, volatile: boolean };
  volumioStop: () => any;
}

export interface MPDPlugin {
  ignoreUpdate: (value: boolean) => void;
}

export interface VolumioStateTranformer {
  transformStateBeforePush?: (state: VolumioState) => VolumioState;
  /**
   * 
   * @param playerTime Player seek position in milliseconds
   * @returns 
   */
  modifyVolatileSeekBeforeSet?: (playerTime: number) => number;
}

export interface VolumioContext {
  commandRouter: CommandRouter;
  statemachine: StateMachine;
  mpdPlugin: MPDPlugin;
  stateTransformer?: VolumioStateTranformer;
  /**
   * Whether to unset ourselves from volatile state when player stops.
   * - `always`: always unset when player stops.
   * - `never`: never unset.
   * - 'manual': only unset when stop() was called, If player stops because
   *    playback has finished, this will not trigger unset.
   * Default: `always`
   */
  unsetVolatileOnStop?: 'always' | 'never' | 'manual';
}

export function validateVolumioContext(value: any): value is VolumioContext {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return (
    validateStateMachine(value['statemachine']) &&
    validateCommandRouter(value['commandRouter']) &&
    validateMPDPlugin(value['mpdPlugin'])
  );
}

function fnsExist(target: any, fns: string[]) {
  return fns.every((fn) => typeof target[fn] === 'function');
}

function validateStateMachine(value: any): value is StateMachine {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const fns = [
    'getNextIndex',
    'stopPlaybackTimer',
    'updateTrackBlock',
    'play',
    'unSetVolatile',
    'setVolatile',
    'setConsumeUpdateService'
  ];
  const rqExists = typeof _.get(value, 'randomQueue.prev') === 'function';

  return fnsExist(value, fns) && rqExists;
}

function validateCommandRouter(value: any): value is CommandRouter {
  if (!value || typeof value !== 'object') {
    return false;
  } 
  const fns = [
    'servicePushState',
    'volumioGetState',
    'volumioStop'
  ];
  return fnsExist(value, fns);
}

function validateMPDPlugin(value: any): value is MPDPlugin {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return fnsExist(value, ['ignoreUpdate']);
}