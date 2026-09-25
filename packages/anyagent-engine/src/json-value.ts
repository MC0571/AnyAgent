export type EngineJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly EngineJsonValue[]
  | { readonly [key: string]: EngineJsonValue };
