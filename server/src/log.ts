export type Logger = (event: string, data?: Record<string, unknown>) => void;

/** 单行 JSON 日志，方便在 Render 控制台检索 */
export const jsonLogger: Logger = (event, data) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ev: event, ...data }));
};

export const silentLogger: Logger = () => {};
