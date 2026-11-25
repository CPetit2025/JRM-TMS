import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'

// Recordatorios locales del cierre de jornada (sin servidor). En un APK anterior sin el plugin no hace nada.
const IDS = [4101, 4102]
const HOURS: Array<[number, number]> = [[18, 0], [20, 30]]

/** Programa los avisos de hoy si la jornada está abierta; si ya se cerró (o no hay jornada), los cancela. */
export async function syncWorkdayReminder(open: boolean) {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('LocalNotifications')) return
  try {
    await LocalNotifications.cancel({ notifications: IDS.map(id => ({ id })) })
    if (!open) return
    const now = new Date()
    const notifications = HOURS.map(([h, m], i) => ({ id: IDS[i], at: new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m) }))
      .filter(n => n.at > now)
      .map(n => ({ id: n.id, title: 'Cierra tu jornada', body: 'Registra el odómetro final de la unidad. Sin él, mañana no podrás hacer el checklist.', schedule: { at: n.at, allowWhileIdle: true }, extra: { url: '/app/jornada' } }))
    if (!notifications.length) return
    const perm = await LocalNotifications.checkPermissions()
    if (perm.display !== 'granted' && (await LocalNotifications.requestPermissions()).display !== 'granted') return
    await LocalNotifications.schedule({ notifications })
  } catch { /* el recordatorio es una ayuda: si falla, el bloqueo del checklist sigue vigente */ }
}

/** Al tocar el aviso se abre la pantalla de cierre. */
export function listenWorkdayReminderTap(go: (url: string) => void) {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('LocalNotifications')) return () => {}
  const handle = LocalNotifications.addListener('localNotificationActionPerformed', e => {
    const url = e.notification.extra?.url
    if (typeof url === 'string' && url.startsWith('/app/')) go(url)
  })
  return () => { void handle.then(h => h.remove()) }
}
