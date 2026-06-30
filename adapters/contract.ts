// adapters/contract.ts
// One protocol every implementation speaks. Adding a language = one Adapter.
// encode/decode work on TEXT (json string <-> toon string) so the harness
// never has to hold a language's native value model.

export interface Adapter {
  name: string;
  encode(jsonText: string): Promise<string>; // JSON text -> TOON text
  decode(toonText: string): Promise<string>; // TOON text -> JSON text
}
