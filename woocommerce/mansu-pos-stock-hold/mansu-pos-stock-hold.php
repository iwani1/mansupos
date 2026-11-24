<?php
/**
 * Plugin Name: Mansu POS Stock Hold
 * Description: Lets the Mansu POS hold stock for its unpaid till orders the same way the website checkout does (WooCommerce's own reserved-stock table), so the shop and the website cannot both sell the last unit.
 * Version: 1.0.0
 * Requires Plugins: woocommerce
 * Requires PHP: 7.4
 * Text Domain: mansu-pos-stock-hold
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'MANSU_POS_STOCK_HOLD_VERSION', '1.0.0' );

/*
 * How it works
 * ------------
 * The website checkout already reserves stock while a customer pays: WooCommerce
 * writes a row to its wc_reserved_stock table and refuses another checkout that
 * would need the same units. Orders the POS creates through the REST API do not
 * get that reservation. This plugin adds one authenticated route the POS calls
 * right after it creates an unpaid till order, which runs WooCommerce's own
 * ReserveStock helper for that order. Two effects:
 *
 *  - If the units are already reserved (a website customer is paying, or another
 *    till order holds them), the hold is refused and the POS cancels its order.
 *  - If the hold succeeds, a website checkout for the same last unit is refused
 *    by WooCommerce until the till order is paid or cancelled.
 *
 * WooCommerce releases the hold itself when the order is paid, completed or
 * cancelled, and the hold expires after the minutes the POS asks for (at most
 * 24 hours). No stock quantity is changed by this plugin.
 *
 * The route lives under a "wc-" namespace so WooCommerce authenticates the POS's
 * existing REST API key (Read/Write); no extra password is needed.
 */

function mansu_pos_stock_hold_error( $code, $message, $status ) {
	return new WP_Error( $code, $message, array( 'status' => $status ) );
}

function mansu_pos_stock_hold_available() {
	return class_exists( 'WooCommerce' ) && function_exists( 'wc_get_order' ) &&
		class_exists( '\\Automattic\\WooCommerce\\Checkout\\Helpers\\ReserveStock' ) &&
		(int) get_option( 'woocommerce_schema_version', 0 ) >= 430 &&
		get_option( 'woocommerce_manage_stock' ) === 'yes';
}

function mansu_pos_stock_hold_permission() {
	if ( ! is_ssl() && ! in_array( $_SERVER['REMOTE_ADDR'] ?? '', array( '127.0.0.1', '::1' ), true ) ) {
		return mansu_pos_stock_hold_error( 'mansu_tls', 'HTTPS is required.', 403 );
	}
	if ( ! current_user_can( 'edit_shop_orders' ) ) {
		return mansu_pos_stock_hold_error( 'mansu_forbidden', 'This API key cannot manage orders.', 403 );
	}
	return true;
}

add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			'wc-mansu-pos/v1',
			'/stock-hold/status',
			array(
				'methods'             => 'GET',
				'callback'            => 'mansu_pos_stock_hold_status',
				'permission_callback' => 'mansu_pos_stock_hold_permission',
			)
		);
		register_rest_route(
			'wc-mansu-pos/v1',
			'/stock-hold',
			array(
				'methods'             => 'POST',
				'callback'            => 'mansu_pos_stock_hold_reserve',
				'permission_callback' => 'mansu_pos_stock_hold_permission',
				'args'                => array(
					'order_id' => array( 'required' => true, 'type' => 'integer', 'minimum' => 1 ),
					'minutes'  => array( 'required' => true, 'type' => 'integer', 'minimum' => 1, 'maximum' => 1440 ),
				),
			)
		);
	}
);

function mansu_pos_stock_hold_status() {
	return array(
		'ok'          => mansu_pos_stock_hold_available(),
		'version'     => MANSU_POS_STOCK_HOLD_VERSION,
		'woocommerce' => defined( 'WC_VERSION' ) ? WC_VERSION : null,
		'holdMinutes' => (int) get_option( 'woocommerce_hold_stock_minutes', 0 ),
	);
}

function mansu_pos_stock_hold_reserve( WP_REST_Request $request ) {
	if ( ! mansu_pos_stock_hold_available() ) {
		return mansu_pos_stock_hold_error( 'mansu_unavailable', 'WooCommerce stock holds are not available on this store (WooCommerce 4.3+ with stock management on is required).', 503 );
	}
	$order = wc_get_order( (int) $request['order_id'] );
	if ( ! $order || 'shop_order' !== $order->get_type() ) {
		return mansu_pos_stock_hold_error( 'mansu_order_missing', 'Order not found.', 404 );
	}
	// Only till orders, and only while unpaid: never touch website checkouts.
	if ( 'mansu-pos' !== $order->get_meta( '_mansu_pos_channel' ) ) {
		return mansu_pos_stock_hold_error( 'mansu_not_pos_order', 'Only Mansu POS orders can be held here.', 403 );
	}
	if ( 'pending' !== $order->get_status() || $order->is_paid() ) {
		return mansu_pos_stock_hold_error( 'mansu_order_not_pending', 'Only an unpaid pending order can hold stock.', 409 );
	}
	try {
		// The same helper and SQL the website checkout uses. Holding again for
		// the same order replaces its own rows and extends the expiry.
		$reserve = new \Automattic\WooCommerce\Checkout\Helpers\ReserveStock();
		$reserve->reserve_stock_for_order( $order, (int) $request['minutes'] );
	} catch ( \Automattic\WooCommerce\Checkout\Helpers\ReserveStockException $e ) {
		return mansu_pos_stock_hold_error( 'mansu_stock_unavailable', wp_strip_all_tags( $e->getMessage() ), 409 );
	}
	return array(
		'held'    => true,
		'orderId' => $order->get_id(),
		'minutes' => (int) $request['minutes'],
	);
}
