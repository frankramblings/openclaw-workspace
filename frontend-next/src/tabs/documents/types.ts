export interface DocumentRow { id:string; title:string; language:string; preview:string; updated_at:string; version_count:number; session_name?:string;session_id?:string }
export interface DocumentLibrary { documents:DocumentRow[]; total:number; languages:Record<string,number>; session_count:number }
export interface DocumentFull extends DocumentRow { current_content:string; archived?:boolean }
export interface Version { version:number; updated_at:string }
