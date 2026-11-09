import { z } from 'zod';
import { defineModule, manifestFromPackage } from '$lib/sdk/server';
import pkg from './atrium-module.json';
import { bookingEndpoints } from './bookings.endpoints';
import type { RoomsService } from './contract';
import { roomsDashboard } from './dashboard';
import { planEndpoints, replanJob } from './plan.endpoints';
import { onUserDeleted, resetAreas, resetUsers, subjectExport } from './privacy';
import { roomsService } from './refs.service';
import { roomEndpoints } from './rooms.endpoints';
import {
	NOTIFY_MOVED,
	NOTIFY_OBJECTION,
	NOTIFY_SWAP,
	NOTIFY_SWAP_ANSWER,
	NOTIFY_UNASSIGNED,
	PERM_CREATE,
	PERM_EDIT_ALL,
	PERM_FIX,
	PERM_MANAGE,
	PERM_SETTINGS,
	PERM_VIEW,
	SETTING,
	SETTING_DEFAULTS
} from './schemas';
import { roomsSearch } from './search';
import { workflowEndpoints } from './workflow.endpoints';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_raumplanung2.sql?raw';

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export default defineModule({
	package: pkg,
	manifest: {
		// Kennung, Name, Beschreibung, Version, Abhängigkeiten: atrium-module.json
		...manifestFromPackage(pkg),
		permissions: [PERM_VIEW, PERM_CREATE, PERM_FIX, PERM_EDIT_ALL, PERM_MANAGE, PERM_SETTINGS],
		permissionDescriptions: {
			[PERM_VIEW]: 'Räume und Belegungsplan ansehen; Grundrecht für das Modul',
			[PERM_CREATE]: 'Räume nach Anforderungen buchen (der Raum wird automatisch zugewiesen)',
			[PERM_FIX]:
				'Einen bestimmten Raum fest buchen (feste Buchungen werden bei der Optimierung nicht verschoben)',
			[PERM_EDIT_ALL]: 'Alle Raumbuchungen bearbeiten, absagen und löschen',
			[PERM_MANAGE]: 'Räume, Merkmale und Sperrzeiten verwalten, Gesamtoptimierung starten',
			[PERM_SETTINGS]: 'Einstellungen der Raumplanung ändern (Planungszeitraum, Puffer, Gewichte)'
		},
		defaultRoleGrants: { Mitglied: [PERM_VIEW, PERM_CREATE] },
		navigation: [
			{
				label: 'Räume',
				icon: 'house',
				path: '/modules/rooms',
				permission: PERM_VIEW,
				order: 15
			},
			{
				label: 'Raumverwaltung',
				icon: 'house',
				path: '/modules/rooms/admin',
				permission: PERM_MANAGE,
				admin: true
			}
		]
	},
	settings: [
		{
			key: SETTING.horizonDays,
			label: 'Planungszeitraum (Tage)',
			description:
				'So weit im Voraus werden Räume zugewiesen und Buchungen angenommen. Spätere Termine einer Serie plant der tägliche Lauf nach.',
			schema: int(14, 730),
			default: SETTING_DEFAULTS.horizonDays
		},
		{
			key: SETTING.lockDays,
			label: 'Feste Zuweisung vor dem Termin (Tage)',
			description:
				'Termine, die in weniger als so vielen Tagen stattfinden, werden nicht mehr automatisch in einen anderen Raum verlegt.',
			schema: int(0, 60),
			default: SETTING_DEFAULTS.lockDays
		},
		{
			key: SETTING.bufferMinutes,
			label: 'Puffer zwischen zwei Belegungen (Minuten)',
			description: 'Zeit zum Aufräumen und Lüften zwischen zwei Terminen im selben Raum.',
			schema: int(0, 240),
			default: SETTING_DEFAULTS.bufferMinutes
		},
		{
			key: SETTING.warmGapMinutes,
			label: '„Schon geheizt“ bis (Minuten Abstand)',
			description:
				'Folgt ein Termin im selben Raum mit höchstens diesem Abstand, gilt der Raum als schon warm (bevorzugt).',
			schema: int(0, 480),
			default: SETTING_DEFAULTS.warmGapMinutes
		},
		{
			key: SETTING.warmPercent,
			label: 'Ersparnis „schon geheizt“ (% einer Heizstunde)',
			schema: int(0, 100),
			default: SETTING_DEFAULTS.warmPercent
		},
		{
			key: SETTING.oversizeCents,
			label: 'Gewicht: freier Platz (Cent je Platz)',
			description:
				'Je höher, desto stärker werden kleine Räume bevorzugt – auch ohne Heizkosten-Angabe.',
			schema: int(0, 10000),
			default: SETTING_DEFAULTS.oversizeCents
		},
		{
			key: SETTING.moveCents,
			label: 'Gewicht: Raumwechsel (Cent)',
			description:
				'Je höher, desto seltener werden bestehende Buchungen nur für eine kleine Ersparnis verlegt.',
			schema: int(0, 100000),
			default: SETTING_DEFAULTS.moveCents
		},
		{
			key: SETTING.seriesCents,
			label: 'Gewicht: anderer Raum als sonst bei Serien (Cent)',
			schema: int(0, 100000),
			default: SETTING_DEFAULTS.seriesCents
		}
	],
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_raumplanung2', sql: m0002 }
	],
	search: roomsSearch,
	dashboard: roomsDashboard,
	notifications: {
		types: [
			{
				key: NOTIFY_MOVED,
				label: 'Raum geändert',
				description: 'Wenn eine deiner Buchungen automatisch in einen anderen Raum verlegt wurde.',
				defaultChannel: 'email',
				permission: PERM_VIEW
			},
			{
				key: NOTIFY_SWAP,
				label: 'Tauschanfrage',
				description: 'Wenn eine andere Gruppe um den Raum deiner festen Buchung bittet.',
				defaultChannel: 'email',
				permission: PERM_VIEW
			},
			{
				key: NOTIFY_SWAP_ANSWER,
				label: 'Antwort auf Tauschanfrage',
				description: 'Wenn deine Tauschanfrage angenommen, abgelehnt oder abgelaufen ist.',
				defaultChannel: 'email',
				permission: PERM_VIEW
			},
			{
				key: NOTIFY_OBJECTION,
				label: 'Widerspruch gegen Verlegung',
				description:
					'Für die Raumverwaltung: eine Gruppe ist mit ihrem neuen Raum nicht einverstanden.',
				defaultChannel: 'email',
				permission: PERM_MANAGE
			},
			{
				key: NOTIFY_UNASSIGNED,
				label: 'Kein Raum mehr frei',
				description:
					'Wenn für eine Buchung kein passender Raum mehr frei ist (z. B. wegen einer Sperrzeit).',
				defaultChannel: 'email',
				permission: PERM_VIEW
			}
		]
	},
	jobs: [replanJob],
	resetAreas,
	resetUsers,
	onUserDeleted,
	subjectExport,
	/** Dienst für andere Module (`RoomsService`, siehe `contract.ts`) */
	provides: roomsService satisfies RoomsService,
	// Feste Pfade vor `:id`-Mustern; die Vorkommen-Unterpfade (`…/room`, `…/targets`) vor `bookingEndpoints`
	endpoints: [...planEndpoints, ...roomEndpoints, ...workflowEndpoints, ...bookingEndpoints]
});
