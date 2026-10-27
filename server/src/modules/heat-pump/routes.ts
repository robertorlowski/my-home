import express from 'express'

import { getHp, addHp, getHpAll, getHpAvailableDates, getHp4Day, getHpMonthlySummary, getLastError, getDiagnostics, putDiagnostics } from './controllers/hp.controller'
import { prepareOperation, setOperation, setOperationAction } from './controllers/operation.controller'
import { createScheduleEntry, deleteScheduleEntry, getCurrentScheduleEntry, getScheduleEntries, updateScheduleEntry } from './controllers/schedule.controller'
import { addPv, getPv, getPvForRange } from './controllers/pv.controller'
import { getCwuLoadingState, putCwuLoadingState } from './controllers/cwu-loading.controller'

// Pompa ciepła (sterownik co): telemetria, PV, operacje, harmonogramy.
const router = express.Router()

// /operation: wartości do formularza Ustawień (z telemetrii); bieżącą operację sterownik dostaje w odpowiedzi /hp/add
router.get('/operation', prepareOperation);
router.post('/operation/set', setOperation);
router.post('/operation/action', setOperationAction);

router.get('/hp', getHp)
router.get('/hp/all', getHpAll)
router.get('/hp/dates', getHpAvailableDates)
router.get('/hp/4day', getHp4Day)
router.get('/hp/monthly-summary', getHpMonthlySummary)
router.get('/hp/last-error', getLastError)
router.post('/hp/add', addHp)
// diagnostyka magistrali sterownika co: liczniki i zrzuty (GET), zlecenie z czasem wygaśnięcia (PUT)
router.get('/hp/diagnostics', getDiagnostics)
router.put('/hp/diagnostics', putDiagnostics)
// ładowanie CWU w kotle zasilanym przez pompę: kocioł zgłasza (PUT, z rootId pompy), ekran główny czyta (GET)
router.get('/hp/cwu-loading', getCwuLoadingState)
router.put('/hp/cwu-loading', putCwuLoadingState)

router.get('/pv', getPv)
router.get('/pv/range', getPvForRange)
router.post('/pv/add', addPv)

router.get('/schedules', getScheduleEntries)
router.get('/schedules/current', getCurrentScheduleEntry)
router.post('/schedules', createScheduleEntry)
router.put('/schedules/:id', updateScheduleEntry)
router.delete('/schedules/:id', deleteScheduleEntry)

export default router
