<?php
/**
 * Mansu Rosé theme bootstrap.
 *
 * A soft boutique WooCommerce theme for Mansutrendzgh, built around a 3-step Style Finder. WooCommerce renders every
 * product list, cart and checkout on the server (crawlable, works without JS);
 * assets/js/rose.js adds search suggestions, quick view and the bag drawer.
 *
 * @package Mansu_Rose
 */

defined( 'ABSPATH' ) || exit;

define( 'MANSU_ROSE_VERSION', '1.0.0' );
define( 'MANSU_ROSE_DIR', get_template_directory() );
define( 'MANSU_ROSE_URI', get_template_directory_uri() );

require MANSU_ROSE_DIR . '/inc/helpers.php';
require MANSU_ROSE_DIR . '/inc/setup.php';
require MANSU_ROSE_DIR . '/inc/customizer.php';
require MANSU_ROSE_DIR . '/inc/assets.php';
require MANSU_ROSE_DIR . '/inc/schema.php';

if ( class_exists( 'WooCommerce' ) ) {
	require MANSU_ROSE_DIR . '/inc/woocommerce.php';
	require MANSU_ROSE_DIR . '/inc/filters.php';
	require MANSU_ROSE_DIR . '/inc/ajax.php';
	require MANSU_ROSE_DIR . '/inc/finder.php';
}
