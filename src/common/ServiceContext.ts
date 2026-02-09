import { type VolumioContext } from "./VolumioContext";

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface ServiceContext {
  serviceName: string;
  logger: Logger;
  volumio?: VolumioContext;
}