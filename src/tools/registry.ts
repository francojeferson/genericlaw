export interface ToolParameter {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
  enum?: string[];
  properties?: Record<string, ToolParameter>;
  items?: ToolParameter;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameter>;
    required: string[];
  };
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface ITool {
  readonly definition: ToolDefinition;
  validateArgs(args: Record<string, unknown>): { valid: boolean; errors?: string[] };
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

export abstract class BaseTool implements ITool {
  abstract readonly definition: ToolDefinition;
  abstract execute(args: Record<string, unknown>): Promise<ToolResult>;

  validateArgs(args: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];
    const { properties, required } = this.definition.parameters;

    for (const key of required) {
      if (!(key in args) || args[key] === undefined || args[key] === null) {
        errors.push(`Missing required parameter: '${key}'`);
      }
    }

    for (const [key, value] of Object.entries(args)) {
      const schema = properties[key];
      if (!schema) continue;

      if (schema.type === "string" && typeof value !== "string") {
        errors.push(`Parameter '${key}' expected string, got ${typeof value}`);
      } else if (schema.type === "number" && typeof value !== "number") {
        errors.push(`Parameter '${key}' expected number, got ${typeof value}`);
      } else if (schema.type === "boolean" && typeof value !== "boolean") {
        errors.push(`Parameter '${key}' expected boolean, got ${typeof value}`);
      } else if (schema.enum && !schema.enum.includes(value as string)) {
        errors.push(`Parameter '${key}' must be one of: ${schema.enum.join(", ")}`);
      }
    }

    return errors.length === 0 ? { valid: true } : { valid: false, errors };
  }
}

export class ToolRegistry {
  private tools: Map<string, ITool> = new Map();

  register(tool: ITool): void {
    const name = tool.definition.name;
    if (this.tools.has(name)) {
      console.warn(`[ToolRegistry] Duplicate tool '${name}' replaced.`);
    }
    this.tools.set(name, tool);
  }

  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ITool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' not found.`);
    }
    return tool;
  }
}

export class ToolFactory {
  constructor(private registry: ToolRegistry) {}

  create(name: string): ITool {
    return this.registry.get(name);
  }
}