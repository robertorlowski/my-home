// Zakładka Ustawienia pompy (/settings) w układzie makiety „Instrument” (#s-hp-ustawienia): po lewej karta „Ustaw”
// (operacja ręczna, POST /operation/set: tryb pracy, temperatura od–do, limit mocy, EEV, przełączniki wymuszenia
// i pomp obiegu), po prawej karty „Błędy sterownika” (ostatni błąd, licznik, Odblokuj i Restart przez
// POST /operation/action), „Sterownik” (core ControllerCard: nazwa, SN, Root ID, adres IP, firmware, klucz poczty; popup DeviceEditModal) i „Udostępnianie”.
// Wartości początkowe (placeholdery i przełączniki) to rzeczywisty stan pompy z telemetrii (GET /operation),
// a nie ostatnio wysłane ustawienie. Stan jest wczytywany tylko przy wejściu na stronę.
import '../style.css';
import './style.css';
import { HpRequests } from '../../api';
import { HpEntry, OperationEntry, pumpWorkMode } from '../../types';
import { useEffect, useMemo, useState } from 'react';
import Notification, { useSaveNotice } from '../../../../core/components/Notification';
import { DeviceEditModal } from '../../../../core/components/DeviceEditModal';
import { ControllerCard } from '../../../../core/components/ControllerCard';
import { DeviceSharing } from '../../../../core/components/DeviceSharing';
import { useDevice } from '../../../../core/context/DeviceContext';
import { errorDescription, ERROR_LOCK_LIMIT, isLocked } from '../../utils/errors';
import { Segmented, workModeOptions } from '../../components/Segmented';
import { useLang } from '../../../../core/i18n';
import { Switch } from '../../components/Switch';
import { BellIcon, CheckIcon } from '../../components/icons';

// przegrzanie EEV [°C]: z panelu pompy najmniej 0,1, po restarcie CHPC wartość powyżej 8 wraca do domyślnej
const EEV_SETPOINT_MIN = 0.1;
const EEV_SETPOINT_MAX = 8;

export const Settings: React.FC = () => {
	const { t } = useLang();
	const RUNNING_LOCK_HINT = t('hp.set.runningLock');
	// defaultOperation: stan z serwera; valueOpration: tylko pola zmienione przez użytkownika,
	// bo operacja ręczna nadpisuje harmonogram wyłącznie w przekazanych polach
	const [defaultOperation, setDefaultOperation] = useState<OperationEntry>({});
	const [valueOpration, setValueOperation] = useState<OperationEntry>({});
	// komunikat po wysłaniu; przyciski wysyłania nieaktywne w trakcie i dopóki widać komunikat
	const { notice: saveNotice, showNotice, run, busy } = useSaveNotice();
	const [error, setError] = useState<boolean>(false);
	const { device, selectDevice } = useDevice();
	const [editingDevice, setEditingDevice] = useState(false);
	const [lastError, setLastError] = useState<HpEntry | null>(null);
	const [errorCount, setErrorCount] = useState<number | undefined>(undefined);
	// sprężarka pracuje: pompa sama steruje pompami, a wymuszenie przyjmuje tylko w spoczynku
	const [running, setRunning] = useState(false);

	useEffect(() => {
		HpRequests.getHpLastError()
			.then((resp) => setLastError(resp))
			.catch((err) => console.log(err));
		HpRequests.getCoData()
			.then((resp) => {
				setErrorCount(resp?.HP?.ERRc);
				// HPS przychodzi z CHPC jako 0/1
				setRunning(Number(resp?.HP?.HPS) > 0);
			})
			.catch((err) => console.log(err));
	}, []);

	// akcja jednorazowa: serwer budzi co przez WebSocket, więc dociera do pompy w kilka sekund
	const runAction = (action: 'error_reset' | 'restart', notice: string) => {
		run(() => HpRequests.runOperationAction(action).then(response => {
			const ok = response?.status === 201;
			setError(!ok);
			if (ok) showNotice(notice, 4000);
		}));
	};

	const handleRestart = () => {
		if (!window.confirm(t('hp.set.restartConfirm'))) {
			return;
		}
		runAction('restart', t('hp.set.restartSent'));
	};

	// tryb pracy urządzenia (ręczny / automatyczny / OFF): zmiana tutaj = zmiana w Harmonogramie
	const selectedWorkMode = pumpWorkMode(valueOpration.work_mode || defaultOperation.work_mode);
	// w OFF co zawsze wysyła do pompy force 0; w czasie pracy CHPC ignoruje force
	// running pochodzi z telemetrii przy wejściu na stronę i nie odświeża się; po starcie lub
	// zatrzymaniu sprężarki blokady zmieniają się dopiero po ponownym otwarciu zakładki
	const forceEditable = selectedWorkMode !== 'OFF' && !running;

	// przegrzanie EEV: zakres jak w co (operation_parser.cpp); CHPC zapisuje je w EEPROM bez sprawdzania
	const eevSetpoint = valueOpration.eev_setpoint;
	const eevSetpointValid = eevSetpoint === undefined
		|| (Number(eevSetpoint) >= EEV_SETPOINT_MIN && Number(eevSetpoint) <= EEV_SETPOINT_MAX);

	// temperatura od–do jak na serwerze (pump-mode.service.ts): 1–50 °C, od ≤ do (z wartością pompy dla pola niezmienionego).
	// UWAGA: podniesienie maksymalnej temperatury pompy powyżej 50 °C wymaga podniesienia progu wstrzymania pompy przy gorącym kotle
	// (BOILER_BLOCK_FROM 52 °C = maks. 50 + 2, server/src/modules/heat-pump/services/cwu-loading.service.ts), inaczej pompa
	// zatrzyma się na wodzie, którą sama nagrzała.
	const temperatureProblem = useMemo(() => {
		const changed = [valueOpration.temp_min, valueOpration.temp_max].filter((value) => value !== undefined);
		if (changed.some((value) => !Number.isFinite(Number(value)) || Number(value) < 1 || Number(value) > 50)) {
			return t('hp.tempRange', { min: 1, max: 50 });
		}
		const min = Number(valueOpration.temp_min ?? defaultOperation.temp_min);
		const max = Number(valueOpration.temp_max ?? defaultOperation.temp_max);
		return changed.length > 0 && Number.isFinite(min) && Number.isFinite(max) && min > max
			? t('hp.tempOrder')
			: '';
	}, [valueOpration, defaultOperation]);

	// pole wyczyszczone znika ze zmian (nie idzie jako "" ani "0")
	const setOptional = (field: keyof OperationEntry, value: string) => {
		const { [field]: _cleared, ...rest } = valueOpration;
		setValueOperation(value.trim() ? { ...rest, [field]: value.trim() } : rest);
	};

	const enableSave = useMemo(() => {
		return Object.entries(valueOpration).length > 0 && eevSetpointValid && !temperatureProblem;
	}, [valueOpration, eevSetpointValid, temperatureProblem]);

	useEffect( () => {
		HpRequests.prepareOperation()
			.then((resp) => {
				// przy błędzie HTTP Requests.get zwraca null; bez tego render wywraca się na defaultOperation.work_mode
				setDefaultOperation(resp ?? {});
				if (!resp) setError(true);
			})
			.catch((err) => {
				console.log(err);
				setError(true);
			}
		);
	}, []);

	const showSaveNotice = () => showNotice(t('hp.set.sent'), 4000);

	// Wysyła tylko zmienione pola (POST /operation/set): tryb pracy zapisuje serwer w ustawieniach
	// urządzenia (jak Harmonogram, ręczne ustawienia znikają), temperatury i reszta idą od razu na pompę
	// jako ustawienie ręczne. Temperatura 1–50 °C i przegrzanie EEV 0,1–8 °C są sprawdzane tutaj; limity
	// mocy i EEV stosują dopiero co i CHPC, a faktycznie użyte wartości widać w telemetrii.
	const handleSave = () => {
		if (Object.entries(valueOpration).length == 0) {
			return;
		}

		run(() => HpRequests.setOperation(valueOpration).then(response => {
			setError( response?.status === 201 ? false : true );
			if (response?.status === 201) {
				showSaveNotice();
				// telemetria pokaże zmianę dopiero po kilku sekundach; bez tego pola wracają do starych wartości
				const saved = {...defaultOperation, ...valueOpration};
				if (valueOpration.work_mode === 'OFF') saved.force = "0";
				setDefaultOperation(saved);
			}
			setValueOperation({});
		}));
	}

	const locked = isLocked(errorCount);
	const errorText = lastError?.error_code ? errorDescription(lastError.error_code) : '';
	const toggle = (field: 'force' | 'hot_pomp' | 'cold_pomp' | 'sump_heater') => (on: boolean) =>
		setValueOperation({ ...valueOpration, [field]: on ? "1" : "0" });

	return (
		<div className="page page-device hp-view hp-settings">
			<Notification message={saveNotice} />
			<div className="grid-2 grid-settings">
				<section className="card">
					<header className="card-head"><h2>{t('hp.set.title')}</h2><span className="card-hint">{t('hp.set.hint')}</span></header>
					<Segmented name="u-tryb" label={t('hp.workMode')} value={selectedWorkMode} options={workModeOptions(t)}
						onChange={(mode) => {
							// tryb zapisany = tryb urządzenia; ten sam wybór co w danych nie jest wysyłany
							const { work_mode: _previous, ...rest } = valueOpration;
							setValueOperation(mode === pumpWorkMode(defaultOperation.work_mode) ? rest : { ...rest, work_mode: mode });
						}} />
					<div className="form-grid">
						<label htmlFor="u-tmin">{t('hp.tempFromTo')}</label>
						<div className="range-inputs">
							<input type="number" id="u-tmin" name="temp_min" aria-label={t('hp.tempFrom')} aria-invalid={!!temperatureProblem}
								placeholder={defaultOperation.temp_min} value={valueOpration.temp_min ?? ''}
								onChange={(e) => setOptional('temp_min', e.currentTarget.value)} />
							<span className="dash">–</span>
							<input type="number" name="temp_max" aria-label={t('hp.tempTo')} aria-invalid={!!temperatureProblem}
								placeholder={defaultOperation.temp_max} value={valueOpration.temp_max ?? ''}
								onChange={(e) => setOptional('temp_max', e.currentTarget.value)} />
							<span className="unit-txt">°C</span>
						</div>
						<label htmlFor="u-watt" title={t('hp.set.powerLimitTip')}>{t('hp.powerLimit')}</label>
						<div className="range-inputs">
							<input type="number" id="u-watt" name="working_watt" className="w-wide"
								placeholder={defaultOperation.working_watt} value={valueOpration.working_watt ?? ''}
								onChange={(e) => setOptional('working_watt', e.currentTarget.value)} />
							<span className="unit-txt">W</span>
						</div>
						<label htmlFor="u-eevmin">EEV min / max</label>
						<div className="range-inputs">
							<input type="number" id="u-eevmin" name="eev_min_pulse_open" aria-label="EEV min" min={25}
								placeholder={defaultOperation.eev_min_pulse_open} value={valueOpration.eev_min_pulse_open ?? ''}
								onChange={(e) => setOptional('eev_min_pulse_open', e.currentTarget.value)} />
							<span className="dash">–</span>
							<input type="number" name="eev_max_pulse_open" aria-label="EEV max"
								placeholder={defaultOperation.eev_max_pulse_open} value={valueOpration.eev_max_pulse_open ?? ''}
								onChange={(e) => setOptional('eev_max_pulse_open', e.currentTarget.value)} />
						</div>
						<label htmlFor="u-eevsp" title={`${t('hp.eevSuperheat')} ${EEV_SETPOINT_MIN}–${EEV_SETPOINT_MAX} °C`}>{t('hp.eevSuperheat')}</label>
						<div className="range-inputs">
							<input type="number" id="u-eevsp" name="eev_setpoint" step="0.1" min={EEV_SETPOINT_MIN} max={EEV_SETPOINT_MAX}
								aria-invalid={!eevSetpointValid} placeholder={defaultOperation.eev_setpoint} value={valueOpration.eev_setpoint ?? ''}
								onChange={(e) => setOptional('eev_setpoint', e.currentTarget.value.replace(',', '.'))} />
							<span className="unit-txt">°C</span>
						</div>
					</div>
					{temperatureProblem && <p className="field-error">{temperatureProblem}</p>}
					{!eevSetpointValid && <p className="field-error">{t('hp.eevSuperheat')}: {EEV_SETPOINT_MIN}–{EEV_SETPOINT_MAX} °C.</p>}
					<ul className="toggle-list">
						<li>
							<span className="t-name">{t('hp.set.force')} <small>{t('hp.set.forceOnlyIdle')}</small></span>
							<Switch label={t('hp.set.force')} disabled={!forceEditable}
								title={running ? RUNNING_LOCK_HINT : forceEditable ? t('hp.set.forceTip') : t('hp.set.forceOff')}
								on={(valueOpration.force ?? defaultOperation.force) === "1"} onChange={toggle('force')} />
						</li>
						<li>
							<span className="t-name">{t('hp.set.hotPump')}</span>
							<Switch label={t('hp.set.hotPump')} disabled={running} title={running ? RUNNING_LOCK_HINT : t('hp.set.hotPump')}
								on={(valueOpration.hot_pomp ?? defaultOperation.hot_pomp) === "1"} onChange={toggle('hot_pomp')} />
						</li>
						<li>
							<span className="t-name">{t('hp.set.coldPump')}</span>
							<Switch label={t('hp.set.coldPump')} disabled={running} title={running ? RUNNING_LOCK_HINT : t('hp.set.coldPump')}
								on={(valueOpration.cold_pomp ?? defaultOperation.cold_pomp) === "1"} onChange={toggle('cold_pomp')} />
						</li>
						<li>
							<span className="t-name">{t('hp.set.sumpHeater')}</span>
							<Switch label={t('hp.set.sumpHeater')} title={t('hp.set.sumpHeater')}
								on={(valueOpration.sump_heater ?? defaultOperation.sump_heater) === "1"} onChange={toggle('sump_heater')} />
						</li>
					</ul>
					{error && <p className="field-error">{t('hp.set.error')}</p>}
					<div className="actions">
						<button type="button" className="btn btn-primary" data-action="send-operation" disabled={!enableSave || busy} onClick={handleSave}>{t('hp.set.change')}</button>
					</div>
					{saveNotice && <div className="toast toast-ok" role="status"><CheckIcon />{saveNotice} {t('hp.set.applyNote')}</div>}
				</section>

				<div className="stack">
					<section className="card">
						<header className="card-head">
							<h2>{t('hp.set.errorsTitle')}</h2>
							<span className="card-hint">{t('hp.counter')} {errorCount === undefined ? '---' : `${errorCount}/${ERROR_LOCK_LIMIT}`} · {t('hp.set.lockAt', { n: ERROR_LOCK_LIMIT })}</span>
						</header>
						{errorText || locked ? (
							<div className="alert alert-err">
								<BellIcon />
								<div>
									<strong>{locked ? t('hp.set.controlLocked') : `${t('hp.set.errorWord')} ${lastError?.error_code} · ${errorText}`}</strong>
									<span>{locked ? t('hp.set.lockedText', { count: `${errorCount}/${ERROR_LOCK_LIMIT}` }) : lastError?.time}</span>
								</div>
							</div>
						) : (
							<p className="help"><span className="ok-text">{t('hp.set.noErrors')}</span> {t('hp.set.last24h')}</p>
						)}
						<div className="actions actions-split">
							<button type="button" className="btn" disabled={!locked || busy}
								title={locked ? t('hp.set.unlockTip') : t('hp.set.notLocked')}
								onClick={() => runAction('error_reset', t('hp.set.unlockSent'))}>
								{t('hp.set.unlock')}
							</button>
							<button type="button" className="btn btn-danger-ghost" title={t('hp.set.restartTip')}
								disabled={busy} onClick={handleRestart}>
								{t('hp.set.restart')}
							</button>
						</div>
					</section>

					<ControllerCard device={device} onEdit={() => setEditingDevice(true)} />

					{/* udostępnianie sterownika (tylko właściciel; konta użytkowników) */}
					{device && <DeviceSharing device={device} />}
				</div>
			</div>

			{editingDevice && device && (
				<DeviceEditModal
					device={device}
					onClose={() => setEditingDevice(false)}
					onSaved={(updated) => {
						// nowa nazwa trafia też do zapamiętanego wyboru (stopka, localStorage)
						selectDevice(updated);
						setEditingDevice(false);
					}}
				/>
			)}
		</div>
	);
}
