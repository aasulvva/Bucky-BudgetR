// Every language has exactly the English keys, with the same placeholders,
// so nothing falls back to another language unnoticed.
import en from "./locales/en.json";
import nb from "./locales/nb.json";
import nn from "./locales/nn.json";

interface Tree {
  [key: string]: string | Tree;
}

/** Each key's dotted path and the {{placeholders}} in its text. */
function entries(tree: Tree, prefix = ""): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix + key;
    if (typeof value === "string") {
      out.set(path, [...value.matchAll(/{{\s*(\w+)\s*}}|<(\w+)>/g)].map((m) => m[0]).sort());
    } else {
      for (const [k, v] of entries(value, `${path}.`)) out.set(k, v);
    }
  }
  return out;
}

const english = entries(en);

describe.each([
  ["nb", nb],
  ["nn", nn],
])("%s", (_, resources: Tree) => {
  const translated = entries(resources);

  it("has the English keys, no more and no fewer", () => {
    expect([...translated.keys()].sort()).toEqual([...english.keys()].sort());
  });

  it("has the same placeholders and tags in each text", () => {
    for (const [key, placeholders] of english) {
      expect({ key, placeholders: translated.get(key) }).toEqual({ key, placeholders });
    }
  });
});
