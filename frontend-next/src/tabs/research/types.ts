export interface ResearchProgress { phase?:string; status?:string; final?:boolean; message?:string; error?:string; round?:number; total_sources?:number; total_findings?:number; title?:string; [key:string]:unknown }
export interface ActiveRun { session_id:string; query:string; progress:ResearchProgress; started_at:number }
export interface ResearchRow { id:string; query:string; status:string; started_at:number; duration?:string; source_count?:number; rounds?:number; category?:string }
export interface ResearchLibrary { research:ResearchRow[] }
export interface ResearchResult { result:string; sources:Array<string|Record<string,unknown>>; raw_findings:unknown[]; category:string }
