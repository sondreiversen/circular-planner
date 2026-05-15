import { api } from './api-client';

export interface SavedView {
  id: number;
  name: string;
  state: string;
  isShared: boolean;
  createdBy: { id: number; username: string; fullName?: string };
}

export async function listViews(plannerId: number): Promise<SavedView[]> {
  return api.get<SavedView[]>(`/api/planners/${plannerId}/views`);
}

export async function createView(
  plannerId: number,
  name: string,
  state: string,
  isShared: boolean,
): Promise<{ id: number }> {
  return api.post<{ id: number }>(`/api/planners/${plannerId}/views`, { name, state, isShared });
}

export async function deleteView(plannerId: number, viewId: number): Promise<void> {
  return api.delete<void>(`/api/planners/${plannerId}/views/${viewId}`);
}
