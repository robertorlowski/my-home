// Opis rodzaju „fotowoltaika” dla rejestru core/device-types.ts. Urządzenie zakłada serwer przy
// odczycie PV od sterownika co (heat-pump pv.service → ensurePhotovoltaicDevice), z tym samym SN;
// własnego sterownika nie ma (DTU czyta co), więc nie ma ustawień dla sterownika.
import { DeviceType, DeviceTypeModule } from '../../core/types';
import { photovoltaicTile } from './tile';

export const photovoltaicDeviceType: DeviceTypeModule = {
  type: DeviceType.PHOTOVOLTAIC,
  tile: photovoltaicTile,
};
