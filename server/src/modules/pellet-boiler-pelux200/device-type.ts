// Opis rodzaju „kocioł pelletowy Pellux 200” dla rejestru core/device-types.ts:
// ustawienia nowego urządzenia i ustawienia odsyłane sterownikowi przy zgłoszeniu.
import { DeviceProperties, DeviceType, DeviceTypeModule } from '../../core/types';
import { noteBoilerControllerStart } from './services/pellet-boiler-pelux200-diagnostics.service';
import { checkBoilerDefinition, initBoilerDefinition } from './services/pellet-boiler-pelux200-heat-pump-link.service';
import { pelletBoilerTile } from './tile';
import { plannedScheduleOperations } from './services/pellet-boiler-pelux200-schedule.service';

// Co minutę (od 2026-10-05, cykl Zimy w trybie pompy ciepła reaguje na temperaturę kotła; wcześniej 5 min);
// zakres 30–3600 s pilnuje schemat properties (core/models/device.model.ts).
export const DEFAULT_POLL_INTERVAL_SECONDS = 60;
// cena pelletu [zł/t] do kosztu ogrzewania na wykresie (decyzja użytkownika 2026-10-13: 2000 zł za tonę)
export const DEFAULT_PELLET_PRICE_PER_TON = 2000;
export const DEFAULT_PELLET_BOILER_PELUX200_PROPERTIES: DeviceProperties = {
  poll_interval_seconds: DEFAULT_POLL_INTERVAL_SECONDS,
  pellet_price_per_ton: DEFAULT_PELLET_PRICE_PER_TON,
};

export const pelletBoilerPelux200DeviceType: DeviceTypeModule = {
  type: DeviceType.PELLET_BOILER_PELUX200,
  initialProperties: DEFAULT_PELLET_BOILER_PELUX200_PROPERTIES,
  controllerSettings: (properties) => ({
    poll_interval_seconds: properties.poll_interval_seconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
  }),
  // OTA na zlecenie („Aktualizuj”); oferta idzie też w odpowiedzi GET …/commands/next (od firmware 1.5.0)
  firmwareUpdates: true,
  // powiązanie z pompą ciepła (heat-pump-link.service): nowy kocioł bez pompy, odłączenie tylko w trybie Pellet;
  // od firmware 1.11.2 start sterownika z przyczyną w dzienniku operacji (błąd zapisu nie psuje zgłoszenia)
  onRegister: async (rootId, _deviceId, body) => {
    await initBoilerDefinition(rootId);
    await noteBoilerControllerStart(rootId, body).catch((error) => console.error('[pellet] start sterownika w dzienniku:', error));
  },
  checkDefinition: checkBoilerDefinition,
  tile: pelletBoilerTile,
  // dziennik operacji: przejścia harmonogramu do końca doby
  plannedOperations: plannedScheduleOperations,
  propertyLabels: {
    poll_interval_seconds: { label: 'Odpytywanie pieca', unit: 's' },
    pellet_price_per_ton: { label: 'Cena pelletu', unit: 'zł/t' },
  },
};
