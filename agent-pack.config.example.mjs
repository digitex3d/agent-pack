// Copy this file to your project root as agent-pack.config.mjs

// import claudeCodeAdapter from 'agent-pack/adapters/claude-code';
// import cursorAdapter from 'agent-pack/adapters/cursor';

export default {
  // libraryRoot: 'library',                                  // default — project library directory
  //
  // Shared libraries are reachable from agents via `IMPORT … FROM @<alias>.…`.
  // Each entry is an alias pointing at a folder on disk — bring the folder there
  // however you like (git clone, submodule, npm package, shared drive).
  //
  // sharedLibraries: [
  //   { alias: 'shared', path: '~/code/shared-rules', watch: true },
  // ],
  agentsDir: '.claude/agents/definitions',
  outputDir: '.claude/agents/.compiled',

  // Adapters target a specific harness when bundling.
  // Use `agent-pack bundle <name|path> --adapter <name>` to materialize.
  // adapters: [
  //   claudeCodeAdapter(),                                  // .claude/agents + .claude/skills
  //   cursorAdapter({ rulesDir: '.cursor/rules' }),         // .cursor/rules/*.mdc
  // ],
};
