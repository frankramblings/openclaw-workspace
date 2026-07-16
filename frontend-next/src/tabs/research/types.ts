export interface ResearchProgress { phase?:string; status?:string; final?:boolean; message?:string; [key:string]:unknown }
export interface ActiveRun { session_id:string; query:string; progress:ResearchProgress; started_at:number }
export interface ResearchRow { id:string; query:string; status:string; started_at:number; duration?:string; source_count?:number; category?:string }
export interface ResearchLibrary { research:ResearchRow[] }

