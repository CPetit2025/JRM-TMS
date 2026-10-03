'use client'

import { useSyncExternalStore } from 'react'

// Preferencias del menú lateral por usuario (en este navegador): fijado, paleta, secciones abiertas, favoritos y recientes.
// Además, estado de pantalla: abierto como panel (celular o menú sin fijar).

export type SidebarTheme = 'azul' | 'claro'
export interface SidebarState {
  pinned: boolean
  theme: SidebarTheme
  open: string[] | null      // null = solo la sección activa
  favs: string[]             // hrefs, máx. 5
  recents: string[]          // hrefs, máx. 4
  overlay: boolean           // panel visible sin estar fijado (mouse en el borde, ☰ o celular)
}

const KEY = 'jrm.sidebar.v1'
const DEFAULTS: SidebarState = { pinned: true, theme: 'azul', open: null, favs: [], recents: [], overlay: false }
let state: SidebarState = DEFAULTS
let loaded = false
const listeners = new Set<() => void>()

function load() {
  if (loaded || typeof window === 'undefined') return
  loaded = true
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<SidebarState>
    state = {
      ...DEFAULTS,
      pinned: typeof raw.pinned === 'boolean' ? raw.pinned : DEFAULTS.pinned,
      theme: raw.theme === 'claro' ? 'claro' : 'azul',
      open: Array.isArray(raw.open) ? raw.open.filter(x => typeof x === 'string') : null,
      favs: Array.isArray(raw.favs) ? raw.favs.filter(x => typeof x === 'string').slice(0, 5) : [],
      recents: Array.isArray(raw.recents) ? raw.recents.filter(x => typeof x === 'string').slice(0, 4) : [],
    }
  } catch { /* sin almacenamiento: valores por defecto */ }
}

export function setSidebar(patch: Partial<SidebarState> | ((s: SidebarState) => Partial<SidebarState>)) {
  load()
  const p = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...p }
  try {
    const { overlay: _o, ...persist } = state // eslint-disable-line @typescript-eslint/no-unused-vars
    localStorage.setItem(KEY, JSON.stringify(persist))
  } catch { /* ignore */ }
  listeners.forEach(l => l())
}

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } }
function getSnapshot() { load(); return state }
function getServerSnapshot() { return DEFAULTS }

export function useSidebar() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
