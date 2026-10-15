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

export const isAdmin = () => state.user?.role === 'admin';
export const canEdit = () => state.user && state.user.role !== 'viewer';
export const userById = (id) => state.users.find((u) => u.id === id);
export const labelById = (id) => state.labels.find((l) => l.id === id);
export const columnById = (id) => state.columns.find((c) => c.id === id);
