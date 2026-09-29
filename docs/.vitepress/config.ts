// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Giuseppe Federico
import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'agent-pack',
  description: 'A programming language to orchestrate agents across every harness',
  // Static assets served from docs/public are not pages, so the link checker
  // cannot resolve them. Listed one by one rather than disabled wholesale.
  ignoreDeadLinks: [/^\/structured-format\.example\.json$/],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/cli' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'What is agent-pack', link: '/guide/introduction' },
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'The apx', link: '/guide/apx' },
          { text: 'Teams and flows', link: '/guide/teams-and-flows' },
          { text: 'Adapters', link: '/guide/adapters' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI', link: '/reference/cli' },
          { text: 'Configuration', link: '/reference/config' },
          { text: 'Language', link: '/reference/language' },
          { text: 'Structured Format', link: '/reference/structured-format' },
        ],
      },
    ],
  },
});
