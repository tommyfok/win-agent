import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerSkillsCommands } from '../skills.js';

describe('registerSkillsCommands', () => {
  it('registers the skills command group with sync / update / status subcommands', () => {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined,
    });
    registerSkillsCommands(program);

    const skillsCmd = program.commands.find((c) => c.name() === 'skills');
    expect(skillsCmd).toBeDefined();

    const subcommands = skillsCmd!.commands.map((c) => c.name()).sort();
    expect(subcommands).toEqual(['status', 'sync-agent-skills', 'update-agent-skills']);
  });
});
