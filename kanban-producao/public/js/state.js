// Estado compartilhado da aplicação
export const state = {
  user: null,
  boards: [],
  boardId: null,
  board: null,
  columns: [],
  labels: [],
  fields: [],
  users: [],
  search: '',
  archived: false,
  pageSize: 40,
  dragging: false,
  pendingReload: false,
  openCardId: null,
};

// Alterações feitas por este navegador: o aviso de tempo real que volta delas não precisa redesenhar a tela
const localEdits = new Map();
export function markLocalEdit(cardId) { localEdits.set(cardId, Date.now()); }
export function isOwnEcho(data) {
  if (data.userId !== state.user?.id || !data.cardIds?.length) return false;
  return data.cardIds.every((id) => Date.now() - (localEdits.get(id) || 0) < 5000);
}

export const isAdmin = () => state.user?.role === 'admin';
export const canEdit = () => state.user && state.user.role !== 'viewer';
export const userById = (id) => state.users.find((u) => u.id === id);
export const labelById = (id) => state.labels.find((l) => l.id === id);
export const columnById = (id) => state.columns.find((c) => c.id === id);
