import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/RoomsPage.svelte'),
		admin: () => import('./pages/RoomsAdmin.svelte')
	},
	dashboardWidgets: [
		{
			id: 'my-bookings',
			title: 'Meine Raumbuchungen',
			description: 'Deine nächsten Raumbuchungen mit zugewiesenem Raum',
			order: 30,
			size: 'sm',
			permission: 'rooms.booking.view',
			// Die Woche steht schon im Wochenstreifen der Übersicht
			defaultHidden: true,
			component: () => import('./pages/widgets/MyBookingsWidget.svelte')
		}
	]
} satisfies ModuleUi;
