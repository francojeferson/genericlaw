import type { ProviderFactory } from "../providers/provider-factory.js";
import type { SkillManifest } from "./skill-loader.js";

export class SkillRouter {
  private providerFactory: ProviderFactory;

  constructor(providerFactory: ProviderFactory) {
    this.providerFactory = providerFactory;
  }

  async route(userContent: string, availableSkills: SkillManifest[]): Promise<string | null> {
    if (availableSkills.length === 0) return null;

    let provider;
    try {
      const names = this.providerFactory.getNames();
      if (names.length === 0) return null;
      provider = this.providerFactory.createWithFallback(names);
    } catch {
      return null;
    }

    const skillList = availableSkills
      .map((s) => `- ${s.name}: ${s.description}`)
      .join("\n");

    const systemPrompt = `You are a skill router. Given a user message and a list of available skills, determine which skill (if any) should handle this message.

Available skills:
${skillList}

Rules:
1. Return ONLY a JSON object with the shape {"name": "<name>"} or {"name": null}.
2. Select a skill only if the user message clearly relates to its description.
3. If no skill is relevant, return {"name": null}.
4. Do NOT include any text outside the JSON object.
5. Do NOT explain your reasoning.`;

    try {
      const response = await provider.generate([
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ]);

      const trimmed = response.text.trim();
      let parsed: { name: string | null };

      try {
        const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
        parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { name: null };
      } catch {
        return null;
      }

      if (parsed.name && typeof parsed.name === "string") {
        const exists = availableSkills.some((s) => s.name === parsed.name);
        if (exists) {
          console.info(`[SkillRouter] Selected skill: ${parsed.name}`);
          return parsed.name;
        }
      }

      return null;
    } catch {
      return null;
    }
  }
}