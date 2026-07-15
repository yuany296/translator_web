export default [
  {
    ignores: ["dist/**", "node_modules/**", "tests/**", "tools/**"]
  },
  {
    files: ["extension/src/**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }]
    }
  },
  {
    files: [
      "extension/src/background/index.js",
      "extension/src/content/index.js",
      "extension/src/popup/index.js",
      "extension/src/glossary/index.js"
    ],
    rules: {
      "max-lines": ["error", { max: 120, skipBlankLines: true, skipComments: true }]
    }
  }
];
