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
        if ( $entry['mode'] === 'verify-failed' ) {
            // Synthetic network/transaction verification failure. No request
            // goes to the real Paystack API and no state should advance.
            return new WP_Error( 'ci_paystack_verification_failed', 'Synthetic verification unavailable.' );
        }
        if ( in_array( $entry['mode'], array( 'race-valid', 'race-late' ), true ) ) {
            // Real simultaneous HTTP requests from two distinct PHP workers
            // must both reach verified Paystack response before either proceeds.
            // This barrier ONLY exists in the CI fixture; production has none.
            $dir = WP_CONTENT_DIR . '/mansu-ci-paystack-' . $entry['mode'];
            if ( ! is_dir( $dir ) ) {
                return new WP_Error( 'ci_race_missing', 'Synthetic race directory missing.' );
            }
            $marker = $dir . '/verify-' . getmypid();
            if ( file_put_contents( $marker, (string) microtime( true ), LOCK_EX ) === false ) {
                return new WP_Error( 'ci_race_marker', 'Synthetic race barrier write failed.' );
            }
            $deadline = microtime( true ) + 22;
            $arrivals = glob( $dir . '/verify-*' );
            while ( count( $arrivals ) < 2 && microtime( true ) < $deadline ) {
                usleep( 75000 );
                $arrivals = glob( $dir . '/verify-*' );
            }
            if ( count( $arrivals ) !== 2 ) {
                return new WP_Error( 'ci_race_timeout', 'Both callback workers did not reach verification barrier.' );
            }
            // Keep both Woo order objects stale until the gateway admission.
            usleep( 250000 );
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
