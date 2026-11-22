<?php
/**
 * Mansu Maison theme bootstrap.
 *
 * An editorial WooCommerce theme for Mansutrendzgh. WooCommerce renders every
 * product list, cart and checkout on the server (crawlable, works without JS);
 * assets/js/maison.js adds search suggestions, quick view and the bag drawer.
 *
 * @package Mansu_Maison
 */

defined( 'ABSPATH' ) || exit;

define( 'MANSU_MAISON_VERSION', '1.0.0' );
define( 'MANSU_MAISON_DIR', get_template_directory() );
define( 'MANSU_MAISON_URI', get_template_directory_uri() );

require MANSU_MAISON_DIR . '/inc/helpers.php';
require MANSU_MAISON_DIR . '/inc/setup.php';
require MANSU_MAISON_DIR . '/inc/customizer.php';
require MANSU_MAISON_DIR . '/inc/assets.php';
require MANSU_MAISON_DIR . '/inc/schema.php';

if ( class_exists( 'WooCommerce' ) ) {
	require MANSU_MAISON_DIR . '/inc/woocommerce.php';
	require MANSU_MAISON_DIR . '/inc/filters.php';
	require MANSU_MAISON_DIR . '/inc/ajax.php';
}
