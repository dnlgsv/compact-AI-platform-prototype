import type { AgentRunOptions, AgentRunResult } from "./index.ts";

export type WorkflowDefinition = {
  name: string;
  version: string;
  run(task: string, options?: AgentRunOptions): Promise<AgentRunResult>;
  evalSuite?: string;
};

export type WorkflowSummary = {
  name: string;
  version: string;
  evalSuite?: string;
};

export type WorkflowRegistry = {
  registerWorkflow(definition: WorkflowDefinition): void;
  getWorkflow(name: string, version?: string): WorkflowDefinition;
  listWorkflows(): WorkflowSummary[];
};

export function createWorkflowRegistry(definitions: WorkflowDefinition[] = []): WorkflowRegistry {
  const workflows = new Map<string, WorkflowDefinition>();

  const registry: WorkflowRegistry = {
    registerWorkflow(definition) {
      validateWorkflowDefinition(definition);
      const key = workflowKey(definition.name, definition.version);
      if (workflows.has(key)) {
        throw new Error(`Workflow already registered: ${definition.name}@${definition.version}`);
      }
      workflows.set(key, definition);
    },

    getWorkflow(name, version) {
      if (version) {
        const workflow = workflows.get(workflowKey(name, version));
        if (!workflow) {
          throw new Error(`Workflow not found: ${name}@${version}`);
        }
        return workflow;
      }

      const matches = [...workflows.values()]
        .filter((workflow) => workflow.name === name)
        .sort((a, b) => b.version.localeCompare(a.version));
      const workflow = matches[0];
      if (!workflow) {
        throw new Error(`Workflow not found: ${name}`);
      }
      return workflow;
    },

    listWorkflows() {
      return [...workflows.values()]
        .map((workflow) => ({
          name: workflow.name,
          version: workflow.version,
          evalSuite: workflow.evalSuite,
        }))
        .sort((a, b) => a.name.localeCompare(b.name) || b.version.localeCompare(a.version));
    },
  };

  for (const definition of definitions) {
    registry.registerWorkflow(definition);
  }

  return registry;
}

export function registerWorkflow(registry: WorkflowRegistry, definition: WorkflowDefinition): void {
  registry.registerWorkflow(definition);
}

function validateWorkflowDefinition(definition: WorkflowDefinition): void {
  if (!definition || typeof definition !== "object") {
    throw new Error("Workflow definition must be an object.");
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(definition.name)) {
    throw new Error("Workflow name must be lowercase letters, numbers, underscores, or hyphens.");
  }
  if (typeof definition.version !== "string" || definition.version.length === 0) {
    throw new Error("Workflow version must be a non-empty string.");
  }
  if (typeof definition.run !== "function") {
    throw new Error("Workflow run must be a function.");
  }
}

function workflowKey(name: string, version: string): string {
  return `${name}@${version}`;
}
