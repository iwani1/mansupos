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

/**
 * CI-only concurrency barrier runs just BEFORE the prototype order lock.
 * It proves that two distinct HTTP PHP workers have both entered the actual
 * Paystack gateway callback route concurrently. The upstream handlers will
 * then be serialized by the real draft lock; their verification calls must
 * NOT be made to wait for one another after the lock is taken.
 */
$mansu_ci_paystack_gate = static function () {
    $webhook = current_filter() === 'woocommerce_api_tbz_wc_paystack_webhook';
    if ( $webhook ) {
        $event = json_decode( file_get_contents( 'php://input' ) );
        $ref = $event->data->reference ?? '';
    } else {
        $ref = $_REQUEST['paystack_txnref'] ?? $_REQUEST['reference'] ?? '';
    }
    if ( ! is_string( $ref ) || ! preg_match( '/^[1-9][0-9]*_/', $ref ) ) { return; }
    $fixtures = get_option( 'mansu_ci_paystack_http_cases', array() );
    foreach ( $fixtures as $entry ) {
        if ( $entry['ref'] !== $ref ||
             ! in_array( $entry['mode'], array( 'race-valid', 'race-late' ), true ) ) { continue; }
        $dir = WP_CONTENT_DIR . '/mansu-ci-paystack-' . $entry['mode'];
        if ( ! is_dir( $dir ) || file_put_contents(
            $dir . '/arrival-' . getmypid(), (string) microtime( true ), LOCK_EX
        ) === false ) {
            status_header( 500 );
            exit;
        }
        $deadline = microtime( true ) + 15;
        $arrivals = glob( $dir . '/arrival-*' );
        while ( count( $arrivals ) < 2 && microtime( true ) < $deadline ) {
            usleep( 75000 );
            $arrivals = glob( $dir . '/arrival-*' );
        }
        if ( count( $arrivals ) !== 2 ) {
            status_header( 503 );
            exit;
        }
        return;
    }
};
add_action( 'woocommerce_api_tbz_wc_paystack_webhook', $mansu_ci_paystack_gate, -10 );
add_action( 'woocommerce_api_wc_gateway_paystack', $mansu_ci_paystack_gate, -10 );

// CI only: force the POS cash payment_complete and late website
// payment_complete to run concurrently against the SAME stock owner.
// Neither channel can "pass" this test by avoiding the other callback.
add_action( 'woocommerce_pre_payment_complete', static function ( $order_id ) {
    $cross = get_option( 'mansu_ci_cross_payment', array() );
    if ( ! is_array( $cross ) ||
         ! isset( $cross['websiteId'], $cross['posId'] ) ) { return; }
    if ( (int) $order_id === (int) $cross['websiteId'] ) {
        $channel = 'website';
    } elseif ( (int) $order_id === (int) $cross['posId'] ) {
        $channel = 'pos';
    } else {
        return;
    }
    $dir = WP_CONTENT_DIR . '/mansu-ci-cross-payment';
    if ( ! is_dir( $dir ) ||
         file_put_contents( $dir . '/' . $channel,
             (string) microtime( true ), LOCK_EX ) === false ) {
        throw new RuntimeException( 'Cross-channel synthetic arrival marker failed.' );
    }
    $deadline = microtime( true ) + 28;
    while ( ! is_file( $dir . '/website' ) || ! is_file( $dir . '/pos' ) ) {
        if ( microtime( true ) > $deadline ) {
            throw new RuntimeException( 'POS and Paystack never met the same-item CI barrier.' );
        }
        usleep( 75000 );
    }
    usleep( 150000 );
}, 0, 2 );

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
            // Record actual upstream verification by each PHP worker. The
            // gateway route barrier above is the only synchronization step;
            // doing it here would deadlock with the production order lock.
            $dir = WP_CONTENT_DIR . '/mansu-ci-paystack-' . $entry['mode'];
            if ( ! is_dir( $dir ) ||
                 file_put_contents( $dir . '/verify-' . getmypid(),
                     (string) microtime( true ), LOCK_EX ) === false ) {
                return new WP_Error( 'ci_race_marker', 'Paystack verification worker marker failed.' );
            }
        }
        if ( $entry['mode'] === 'connection-reset' ) {
            // Only the pinned disposable CI may tear down its own local WP
            // connection. This runs AFTER the real Paystack WC-API route
            // acquired GET_LOCK, but BEFORE upstream payment_complete().
            // It reproduces MySQL freeing advisory locks on disconnect.
            $marker = WP_CONTENT_DIR . '/mansu-ci-paystack-connection-reset/evidence.json';
            if ( ! file_exists( $marker ) ) {
                global $wpdb;
                $name = 'mansu-paystack-order-' . (int) $order->get_id();
                $before_connection = $wpdb->get_var( 'SELECT CONNECTION_ID()' );
                $before_held = $wpdb->get_var( $wpdb->prepare(
                    'SELECT CASE WHEN IS_USED_LOCK(%s) = CONNECTION_ID() THEN 1 ELSE 0 END', $name
                ) );
                if ( (string) $before_held !== '1' ) {
                    return new WP_Error( 'ci_no_advisory_lock', 'Real callback did not acquire the order lock.' );
                }
                $closed = $wpdb->close();
                $connected = $wpdb->db_connect( false );
                $after_connection = $wpdb->get_var( 'SELECT CONNECTION_ID()' );
                $after_held = $wpdb->get_var( $wpdb->prepare(
                    'SELECT CASE WHEN IS_USED_LOCK(%s) = CONNECTION_ID() THEN 1 ELSE 0 END', $name
                ) );
                $evidence = array(
                    'closed' => (bool) $closed,
                    'reconnected' => (bool) $connected,
                    'before' => (int) $before_connection,
                    'after' => (int) $after_connection,
                    'owned_before' => (int) $before_held,
                    'owned_after' => (int) $after_held,
                );
                if ( ! $closed || ! $connected ||
                     (int) $after_connection === (int) $before_connection ||
                     (string) $after_held !== '0' ||
                     file_put_contents( $marker, wp_json_encode( $evidence ), LOCK_EX ) === false ) {
                    return new WP_Error( 'ci_connection_reset_failed',
                        'Synthetic MySQL disconnect/reconnect could not be verified.' );
                }
            }
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
