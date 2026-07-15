export class ProviderRegistry {
  #kind;
  #providers = new Map();

  constructor(kind) {
    this.#kind = kind;
  }

  register(provider) {
    const required = this.#kind === "ocr"
      ? ["normalizeConfig", "validate", "checkHealth", "recognize"]
      : ["normalizeConfig", "validate", "checkHealth", "translateBatch", "fingerprint"];
    if (!provider?.id || required.some((name) => typeof provider[name] !== "function")) {
      throw new TypeError(`Invalid ${this.#kind} provider contract`);
    }
    if (this.#providers.has(provider.id)) throw new Error(`Duplicate provider: ${provider.id}`);
    this.#providers.set(provider.id, Object.freeze(provider));
    return this;
  }

  get(id) {
    const provider = this.#providers.get(String(id || ""));
    if (!provider) throw new Error(`Unsupported ${this.#kind} provider: ${id}`);
    return provider;
  }

  ids() {
    return [...this.#providers.keys()];
  }
}
