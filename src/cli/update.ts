import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { confirm, select } from "@inquirer/prompts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the package templates directory.
 * Mirrors the logic in src/workspace/init.ts getTemplatesDir().
 */
function getTemplatesDir(): string {
  const candidates = [
    path.resolve(__dirname, "../templates"),     // dev: src/workspace/ -> src/templates/
    path.resolve(__dirname, "../src/templates"), // dist: dist/ -> src/templates/
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(
    "找不到包内模板目录，已尝试:\n" + candidates.map((c) => `  ${c}`).join("\n")
  );
}

interface FileDiff {
  file: string;
  srcPath: string;
  destPath: string;
  srcContent: string;
  destContent: string | null; // null = file doesn't exist in workspace yet
}

export async function updateCommand() {
  const workspace = process.cwd();
  const rolesDir = path.join(workspace, ".win-agent", "roles");

  if (!fs.existsSync(rolesDir)) {
    console.log("⚠️  工作空间未初始化，请先执行: npx win-agent start");
    process.exit(1);
  }

  let templatesDir: string;
  try {
    templatesDir = path.join(getTemplatesDir(), "roles");
  } catch (err: any) {
    console.log(`❌ ${err.message}`);
    process.exit(1);
  }

  // ── 比较模板与工作空间文件 ──
  const templateFiles = fs.readdirSync(templatesDir).filter((f) => f.endsWith(".md"));

  const upToDate: string[] = [];
  const diffs: FileDiff[] = [];

  for (const file of templateFiles) {
    const srcPath = path.join(templatesDir, file);
    const destPath = path.join(rolesDir, file);
    const srcContent = fs.readFileSync(srcPath, "utf-8");

    if (!fs.existsSync(destPath)) {
      diffs.push({ file, srcPath, destPath, srcContent, destContent: null });
    } else {
      const destContent = fs.readFileSync(destPath, "utf-8");
      if (srcContent === destContent) {
        upToDate.push(file);
      } else {
        diffs.push({ file, srcPath, destPath, srcContent, destContent });
      }
    }
  }

  // ── 显示结果 ──
  console.log("\n📦 win-agent 角色模板更新检查\n");

  if (upToDate.length > 0) {
    console.log(`✅ 已是最新: ${upToDate.join(", ")}`);
  }

  if (diffs.length === 0) {
    console.log("\n🎉 所有角色模板均已是最新版本，无需更新");
    return;
  }

  console.log(`\n📝 发现 ${diffs.length} 个文件与包中最新版本不同:\n`);

  for (const d of diffs) {
    if (d.destContent === null) {
      console.log(`  ＋ ${d.file}  [工作空间中不存在，将新建]`);
    } else {
      const oldLines = d.destContent.split("\n").length;
      const newLines = d.srcContent.split("\n").length;
      const delta = newLines - oldLines;
      const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
      console.log(`  ≠ ${d.file}  (${oldLines} 行 → ${newLines} 行, ${deltaStr})`);
    }
  }

  console.log(`
⚠️  注意：更新会覆盖工作空间中的角色文件。
   如果你手动修改过这些文件，请先备份，或选择"逐个确认"跳过已修改的文件。
   原文件会自动备份到 .win-agent/backups/ 目录。
`);

  // ── 确认方式 ──
  let mode: "all" | "one-by-one" | "cancel";
  try {
    mode = await select({
      message: "如何处理差异文件？",
      choices: [
        { name: "全部更新（覆盖所有差异文件）", value: "all" },
        { name: "逐个确认（每个文件单独决定）", value: "one-by-one" },
        { name: "取消，不做任何修改", value: "cancel" },
      ],
    }) as "all" | "one-by-one" | "cancel";
  } catch {
    console.log("\n已取消");
    return;
  }

  if (mode === "cancel") {
    console.log("   已取消");
    return;
  }

  const backupsDir = path.join(workspace, ".win-agent", "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  let updated = 0;
  let skipped = 0;

  for (const d of diffs) {
    if (mode === "one-by-one") {
      const label = d.destContent === null
        ? `新建 ${d.file}`
        : `覆盖 ${d.file}`;
      let yes: boolean;
      try {
        yes = await confirm({ message: label + "？", default: false });
      } catch {
        console.log("\n已取消");
        break;
      }
      if (!yes) {
        console.log(`   ⏭  跳过: ${d.file}`);
        skipped++;
        continue;
      }
    }

    // Backup existing file before overwriting
    if (d.destContent !== null) {
      const backupName = `${path.basename(d.file, ".md")}.${timestamp}.md`;
      const backupPath = path.join(backupsDir, backupName);
      fs.writeFileSync(backupPath, d.destContent, "utf-8");
    }

    fs.copyFileSync(d.srcPath, d.destPath);
    console.log(`   ✓ 已更新: ${d.file}`);
    updated++;
  }

  console.log(`\n✅ 完成: ${updated} 个文件已更新` + (skipped > 0 ? `，${skipped} 个已跳过` : ""));

  if (updated > 0) {
    console.log(`   备份保存在: .win-agent/backups/`);
    console.log("   如引擎正在运行，重启后生效: npx win-agent stop && npx win-agent start");
  }
}
