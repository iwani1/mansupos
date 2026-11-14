<?php
/**
 * CI-only MU plugin. This file is copied exclusively to disposable WordPress.
 * It prevents outbound Paystack API calls and stubs verification with synthetic
 * transactions; never install it on an actual website.
 */
defined( 'ABSPATH' ) || exit;
add_action( 'init', static function () {
    if ( ! defined( 'MANSU_CI_DISPOSABLE_WOO' ) ||
         MANSU_CI_DISPOSABLE_WOO !== true ||
         wp_get_environment_type() !== 'local' ||
         get_option( 'blogname' ) !== 'Mansu isolated CI stock test' ) {
        wp_die( 'This Paystack gateway fixture cannot run outside synthetic CI.' );
    }
    if ( function_exists( 'WC' ) && WC() && WC()->payment_gateways() ) {
        // Ensure real Paystack gateway callback hooks are registered for the
        // WC-API request, whether from webhook POST or return GET.
        WC()->payment_gateways()->payment_gateways();
    }
}, 50 );

add_filter( 'pre_http_request', static function ( $preempt, $args, $url ) {
    if ( strpos( $url, 'api.paystack.co' ) === false ) {
        return $preempt;
    }
    if ( ! preg_match( '#^https://api\.paystack\.co/transaction/verify/([^/?]+)$#', $url, $match ) ) {
        return new WP_Error( 'ci_paystack_network_blocked', 'Unapproved Paystack call blocked.' );
    }
    $ref = rawurldecode( $match[1] );
    $fixtures = get_option( 'mansu_ci_paystack_http_cases', array() );
    if ( ! is_array( $fixtures ) ) {
        return new WP_Error( 'ci_paystack_no_fixture', 'No synthetic payment fixtures.' );
    }
    foreach ( $fixtures as $entry ) {
        if ( $entry['ref'] !== $ref ) { continue; }
        $order = wc_get_order( $entry['id'] );
        // Only the explicit synthetic 'reference-mismatch' case bypasses
        // the fixture's expected-reference constraint, so the real plugin's
        // own admission check (or lack of one) is exercised independently.
        if ( ! $order || ( $entry['mode'] !== 'reference-mismatch' &&
             $order->get_meta( '_paystack_txn_ref', true ) !== $ref ) ) {
            return new WP_Error( 'ci_paystack_ref_mismatch', 'Synthetic reference mismatch.' );
        }
        $amount = (int) round( (float) $order->get_total() * 100 );
        if ( $entry['mode'] === 'underpaid' ) { $amount -= 100; }
        $currency = $entry['mode'] === 'wrong-currency' ? 'NGN' : 'GHS';
        return array(
            'headers' => array(),
            'response' => array( 'code' => 200, 'message' => 'OK' ),
            'body' => wp_json_encode( array(
                'status' => true,
                'data' => array(
                    'status' => 'success',
                    'reference' => $ref,
                    'amount' => $amount,
                    'currency' => $currency,
                ),
            ) ),
            'cookies' => array(),
            'filename' => null,
        );
    }
    return new WP_Error( 'ci_paystack_unknown_ref', 'Non-fixture Paystack reference blocked.' );
}, 10, 3 );
