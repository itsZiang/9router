import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToExposeCombo(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models: parseJson(row.models, []),
    sortOrder: row.sortOrder ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getExposeCombos() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM exposeCombos ORDER BY sortOrder ASC, createdAt ASC`);
  return rows.map(rowToExposeCombo);
}

export async function getExposeComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM exposeCombos WHERE id = ?`, [id]);
  return rowToExposeCombo(row);
}

export async function getExposeComboByName(name) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM exposeCombos WHERE name = ?`, [name]);
  return rowToExposeCombo(row);
}

export async function createExposeCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const maxRow = db.get(`SELECT MAX(sortOrder) as maxOrder FROM exposeCombos`);
  const sortOrder = (maxRow?.maxOrder ?? -1) + 1;
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: data.models || [],
    sortOrder,
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO exposeCombos(id, name, kind, models, sortOrder, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [combo.id, combo.name, combo.kind, stringifyJson(combo.models), combo.sortOrder, combo.createdAt, combo.updatedAt]
  );
  return combo;
}

export async function updateExposeCombo(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM exposeCombos WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToExposeCombo(row), ...data, updatedAt: new Date().toISOString() };
    db.run(
      `UPDATE exposeCombos SET name = ?, kind = ?, models = ?, updatedAt = ? WHERE id = ?`,
      [merged.name, merged.kind, stringifyJson(merged.models || []), merged.updatedAt, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteExposeCombo(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM exposeCombos WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function reorderExposeCombos(orderedIds) {
  if (!Array.isArray(orderedIds)) return;
  const db = await getAdapter();
  db.transaction(() => {
    orderedIds.forEach((id, index) => {
      db.run(`UPDATE exposeCombos SET sortOrder = ? WHERE id = ?`, [index, id]);
    });
  });
}
