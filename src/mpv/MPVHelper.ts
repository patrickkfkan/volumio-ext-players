import { getErrorMessage } from "../common/Util";

export class MPVHelper {
  static parseJsonIPCData(data: string) {
    const errors: string[] = [];
    const parsed: any[] = [];
    for (const line of data.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) {
        try {
          const json = JSON.parse(trimmed);
          if (json && typeof json === 'object') {
            parsed.push(json);
          }
        }
        catch (error) {
          errors.push(`${getErrorMessage(error)}: ${trimmed}`);
        }
      }
    }
    return {
      parsed,
      errors
    };
  }
}