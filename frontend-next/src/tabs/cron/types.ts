export interface CronJob{id:string;name:string;enabled:boolean;schedule:string;nextWakeAtMs?:number;lastRunAtMs?:number;lastStatus?:string;message?:string}
export interface CronRun{ts:number;status:string;durationMs?:number;summary?:string;error?:string}
export interface LiveJob{id:string;status:string;title?:string;name?:string;startedAt?:string;progress?:number;[key:string]:unknown}

