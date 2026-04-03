import type Database from "better-sqlite3";

interface PermissionRow {
  role: string;
  table_name: string;
  operation: string;
  conditions: string | null;
}

const DEFAULT_PERMISSIONS: PermissionRow[] = [
  // PM permissions
  { role: "PM", table_name: "messages", operation: "select", conditions: null },
  { role: "PM", table_name: "messages", operation: "insert", conditions: null },
  { role: "PM", table_name: "messages", operation: "update", conditions: null },
  { role: "PM", table_name: "tasks", operation: "select", conditions: null },
  { role: "PM", table_name: "tasks", operation: "insert", conditions: null },
  { role: "PM", table_name: "tasks", operation: "update", conditions: null },
  { role: "PM", table_name: "tasks", operation: "delete", conditions: null },
  { role: "PM", table_name: "knowledge", operation: "select", conditions: null },
  { role: "PM", table_name: "knowledge", operation: "insert", conditions: null },
  { role: "PM", table_name: "logs", operation: "select", conditions: null },
  { role: "PM", table_name: "logs", operation: "insert", conditions: null },
  { role: "PM", table_name: "memory", operation: "select", conditions: null },
  { role: "PM", table_name: "memory", operation: "insert", conditions: JSON.stringify({ role: "PM" }) },
  { role: "PM", table_name: "workflow_instances", operation: "select", conditions: null },
  { role: "PM", table_name: "workflow_instances", operation: "insert", conditions: null },
  { role: "PM", table_name: "workflow_instances", operation: "update", conditions: null },
  { role: "PM", table_name: "iterations", operation: "select", conditions: null },
  { role: "PM", table_name: "iterations", operation: "insert", conditions: null },
  { role: "PM", table_name: "iterations", operation: "update", conditions: null },
  { role: "PM", table_name: "proposals", operation: "select", conditions: null },
  { role: "PM", table_name: "proposals", operation: "insert", conditions: null },
  { role: "PM", table_name: "proposals", operation: "update", conditions: null },
  { role: "PM", table_name: "project_config", operation: "select", conditions: null },
  { role: "PM", table_name: "project_config", operation: "insert", conditions: null },
  { role: "PM", table_name: "project_config", operation: "update", conditions: null },

  // SA permissions
  { role: "SA", table_name: "messages", operation: "select", conditions: null },
  { role: "SA", table_name: "messages", operation: "insert", conditions: null },
  { role: "SA", table_name: "tasks", operation: "select", conditions: null },
  { role: "SA", table_name: "tasks", operation: "insert", conditions: null },
  { role: "SA", table_name: "tasks", operation: "update", conditions: null },
  { role: "SA", table_name: "knowledge", operation: "select", conditions: null },
  { role: "SA", table_name: "knowledge", operation: "insert", conditions: null },
  { role: "SA", table_name: "knowledge", operation: "update", conditions: null },
  { role: "SA", table_name: "logs", operation: "select", conditions: null },
  { role: "SA", table_name: "logs", operation: "insert", conditions: null },
  { role: "SA", table_name: "memory", operation: "select", conditions: null },
  { role: "SA", table_name: "memory", operation: "insert", conditions: JSON.stringify({ role: "SA" }) },
  { role: "SA", table_name: "task_dependencies", operation: "select", conditions: null },
  { role: "SA", table_name: "task_dependencies", operation: "insert", conditions: null },
  { role: "SA", table_name: "workflow_instances", operation: "select", conditions: null },
  { role: "SA", table_name: "workflow_instances", operation: "insert", conditions: null },
  { role: "SA", table_name: "workflow_instances", operation: "update", conditions: null },
  { role: "SA", table_name: "proposals", operation: "select", conditions: null },
  { role: "SA", table_name: "proposals", operation: "insert", conditions: null },

  // DEV permissions
  { role: "DEV", table_name: "messages", operation: "select", conditions: null },
  { role: "DEV", table_name: "messages", operation: "insert", conditions: JSON.stringify({ from_role: "DEV" }) },
  { role: "DEV", table_name: "tasks", operation: "select", conditions: null },
  { role: "DEV", table_name: "tasks", operation: "update", conditions: JSON.stringify({ assigned_to: "DEV" }) },
  { role: "DEV", table_name: "task_dependencies", operation: "select", conditions: null },
  { role: "DEV", table_name: "knowledge", operation: "select", conditions: null },
  { role: "DEV", table_name: "logs", operation: "select", conditions: null },
  { role: "DEV", table_name: "logs", operation: "insert", conditions: null },
  { role: "DEV", table_name: "memory", operation: "select", conditions: null },
  { role: "DEV", table_name: "memory", operation: "insert", conditions: JSON.stringify({ role: "DEV" }) },
  { role: "DEV", table_name: "proposals", operation: "select", conditions: null },
  { role: "DEV", table_name: "proposals", operation: "insert", conditions: null },

  // QA permissions
  { role: "QA", table_name: "messages", operation: "select", conditions: null },
  { role: "QA", table_name: "messages", operation: "insert", conditions: JSON.stringify({ from_role: "QA" }) },
  { role: "QA", table_name: "tasks", operation: "select", conditions: null },
  { role: "QA", table_name: "tasks", operation: "update", conditions: JSON.stringify({ status_in: ["in_qa", "pending_qa", "pending_dev", "done", "rejected"] }) },
  { role: "QA", table_name: "knowledge", operation: "select", conditions: null },
  { role: "QA", table_name: "logs", operation: "select", conditions: null },
  { role: "QA", table_name: "logs", operation: "insert", conditions: null },
  { role: "QA", table_name: "memory", operation: "select", conditions: null },
  { role: "QA", table_name: "memory", operation: "insert", conditions: JSON.stringify({ role: "QA" }) },
  { role: "QA", table_name: "proposals", operation: "select", conditions: null },
  { role: "QA", table_name: "proposals", operation: "insert", conditions: null },

  // OPS permissions
  { role: "OPS", table_name: "messages", operation: "select", conditions: null },
  { role: "OPS", table_name: "messages", operation: "insert", conditions: null },
  { role: "OPS", table_name: "tasks", operation: "select", conditions: null },
  { role: "OPS", table_name: "knowledge", operation: "select", conditions: null },
  { role: "OPS", table_name: "knowledge", operation: "insert", conditions: null },
  { role: "OPS", table_name: "knowledge", operation: "update", conditions: null },
  { role: "OPS", table_name: "knowledge", operation: "delete", conditions: null },
  { role: "OPS", table_name: "logs", operation: "select", conditions: null },
  { role: "OPS", table_name: "logs", operation: "insert", conditions: null },
  { role: "OPS", table_name: "memory", operation: "select", conditions: null },
  { role: "OPS", table_name: "memory", operation: "insert", conditions: JSON.stringify({ role: "OPS" }) },
  { role: "OPS", table_name: "iterations", operation: "select", conditions: null },
  { role: "OPS", table_name: "proposals", operation: "select", conditions: null },
  { role: "OPS", table_name: "proposals", operation: "insert", conditions: null },
  { role: "OPS", table_name: "project_config", operation: "select", conditions: null },
];

export function seedPermissions(db: Database.Database): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO role_permissions (role, table_name, operation, conditions) VALUES (?, ?, ?, ?)"
  );

  const tx = db.transaction(() => {
    for (const p of DEFAULT_PERMISSIONS) {
      insert.run(p.role, p.table_name, p.operation, p.conditions);
    }
  });

  tx();
}
