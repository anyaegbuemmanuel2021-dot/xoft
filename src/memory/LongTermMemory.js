import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * LongTermMemory — structured, editable facts store.
 *
 * Persistence is a flat JSON file by default so the system runs with zero
 * external dependencies. This is deliberately behind a small interface
 * (get/put/delete/query) so swapping in Firebase/Appwrite later means
 * rewriting this one file, not touching the Orchestrator or agents.
 *
 * Categories are open-ended strings: 'person', 'project', 'preference',
 * 'rule', 'decision', 'task', 'fact'.
 */
export class LongTermMemory {
  constructor({ dataDir = './data' } = {}) {
    this.filePath = path.join(dataDir, 'long_term_memory.json');
    fs.mkdirSync(dataDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ entries: [] }, null, 2));
    }
  }

  _load() {
    return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
  }

  _save(data) {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  /**
   * @param {string} category
   * @param {string} content human-readable fact
   * @param {object} [metadata] arbitrary extra fields (e.g. {name:'John', relation:'colleague'})
   * @returns {string} id of the new entry
   */
  remember(category, content, metadata = {}) {
    const data = this._load();
    const entry = {
      id: crypto.randomUUID(),
      category,
      content,
      metadata,
      createdAt: new Date().toISOString(),
    };
    data.entries.push(entry);
    this._save(data);
    return entry.id;
  }

  /** @returns {Array<object>} */
  query({ category, textIncludes } = {}) {
    const data = this._load();
    return data.entries.filter((e) => {
      if (category && e.category !== category) return false;
      if (textIncludes && !e.content.toLowerCase().includes(textIncludes.toLowerCase())) return false;
      return true;
    });
  }

  getById(id) {
    return this._load().entries.find((e) => e.id === id) ?? null;
  }

  /** Deletes a single entry by id. Returns true if something was removed. */
  forget(id) {
    const data = this._load();
    const before = data.entries.length;
    data.entries = data.entries.filter((e) => e.id !== id);
    this._save(data);
    return data.entries.length < before;
  }

  /**
   * Deletes every entry matching a filter — e.g. "delete everything about John".
   * Returns the number of entries removed.
   */
  forgetWhere({ category, textIncludes } = {}) {
    const data = this._load();
    const before = data.entries.length;
    data.entries = data.entries.filter((e) => {
      const matchesCategory = category ? e.category === category : true;
      const matchesText = textIncludes
        ? e.content.toLowerCase().includes(textIncludes.toLowerCase())
        : true;
      // Keep entries that do NOT match both filters
      return !(matchesCategory && matchesText);
    });
    this._save(data);
    return before - data.entries.length;
  }

  all() {
    return this._load().entries;
  }
}
