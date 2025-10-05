export type CapabilityValueType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'object'
  | 'array'
  | 'number|null'
  | 'polygon'
  | 'polygon|path';

export interface CapabilityArgument {
  type: CapabilityValueType;
  description?: string;
  required?: boolean;
  optional?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  values?: ReadonlyArray<string>;
  fields?: Record<string, CapabilityArgument>;
  items?: CapabilityArgument;
  max_items?: number;
  max_area_m2?: number;
}

export interface CapabilityGuardrail {
  type:
    | 'retries'
    | 'cooldown_ms'
    | 'confirmation'
    | 'altitude_floor'
    | 'horizontal_separation'
    | 'vertical_separation'
    | 'payload_bytes'
    | 'waypoint_limit'
    | 'area_limit';
  required?: boolean;
  required_for?: ReadonlyArray<string>;
  default?: number;
  max?: number;
  max_m?: number;
  min_ms?: number;
  min_m?: number;
  max_m2?: number;
}

export interface CapabilityReturnField {
  type: CapabilityValueType | 'enum' | 'array' | 'object';
  description?: string;
  optional?: boolean;
  values?: ReadonlyArray<string>;
  fields?: Record<string, CapabilityReturnField>;
  items?: CapabilityReturnField;
}

export interface CapabilityToolDefinition {
  id: string;
  category: 'vision' | 'gimbal' | 'sensor' | 'ui' | 'flight' | 'mission' | 'perception';
  description: string;
  args: Record<string, CapabilityArgument>;
  returns: Record<string, CapabilityReturnField>;
  guardrails: CapabilityGuardrail[];
}

export interface CapabilityManifest {
  version: string;
  generated_by: string;
  tools: CapabilityToolDefinition[];
}

import rawManifest from './agent_capability_manifest.json';

export const capabilityManifest: CapabilityManifest = rawManifest as CapabilityManifest;

export function serializeCapabilityManifest(indent = 2): string {
  return JSON.stringify(capabilityManifest, null, indent);
}
