export interface McpServer{id:string;name:string;status:string;is_enabled:boolean;needs_oauth:boolean;tool_count:number;error?:string}
export interface SettingsSnapshot{config:Record<string,unknown>;capabilities:Record<string,unknown>;gateway:Record<string,unknown>;doctor:Record<string,unknown>;auth:Record<string,unknown>;defaultChat:{endpoint_id:string;model:string};email:Record<string,unknown>;calendar:Record<string,unknown>;mcp:McpServer[]}

