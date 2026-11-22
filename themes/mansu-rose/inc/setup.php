<?php
/**
 * Theme supports, menus and image sizes.
 *
 * @package Mansu_Rose
 */

defined( 'ABSPATH' ) || exit;

add_action(
	'after_setup_theme',
	function () {
		load_theme_textdomain( 'mansu-rose', MANSU_ROSE_DIR . '/languages' );

		add_theme_support( 'title-tag' );
		add_theme_support( 'post-thumbnails' );
		add_theme_support( 'automatic-feed-links' );
		add_theme_support( 'responsive-embeds' );
		add_theme_support( 'html5', array( 'search-form', 'comment-form', 'comment-list', 'gallery', 'caption', 'style', 'script', 'navigation-widgets' ) );
		add_theme_support( 'custom-logo', array( 'height' => 60, 'width' => 280, 'flex-height' => true, 'flex-width' => true ) );

		add_theme_support(
			'woocommerce',
			array(
				'thumbnail_image_width' => 480,
				'single_image_width'    => 900,
				'product_grid'          => array(
					'default_rows'    => 6,
					'min_rows'        => 2,
					'default_columns' => 4,
					'min_columns'     => 2,
					'max_columns'     => 4,
				),
			)
		);
		add_theme_support( 'wc-product-gallery-zoom' );
		add_theme_support( 'wc-product-gallery-lightbox' );
		add_theme_support( 'wc-product-gallery-slider' );

		register_nav_menus(
			array(
				'primary' => __( 'Main menu', 'mansu-rose' ),
				'footer'  => __( 'Footer help links', 'mansu-rose' ),
			)
		);
	}
);

$GLOBALS['content_width'] = 1320;

/**
 * Product photos on the shop are portrait 3:4. Set WooCommerce's crop once when the
 * theme is switched on; WooCommerce regenerates thumbnails in the background.
 */
add_action(
	'after_switch_theme',
	function () {
		if ( ! get_option( 'mansu_rose_crop_set' ) ) {
			update_option( 'woocommerce_thumbnail_cropping', 'custom' );
			update_option( 'woocommerce_thumbnail_cropping_custom_width', '3' );
			update_option( 'woocommerce_thumbnail_cropping_custom_height', '4' );
			update_option( 'mansu_rose_crop_set', 1 );
		}
	}
);

/**
 * Coming from Mansu Maison: copy its shop settings (WhatsApp number, categories,
 * occasions, photos, FAQ) once, so Rosé opens with the same content.
 * Theme settings are stored per theme, so Maison's own settings are not changed.
 */
add_action(
	'after_switch_theme',
	function () {
		if ( get_option( 'mansu_rose_mods_copied' ) ) {
			return;
		}
		$maison = get_option( 'theme_mods_mansu-maison' );
		if ( is_array( $maison ) ) {
			foreach ( $maison as $key => $value ) {
				if ( 0 === strpos( (string) $key, 'mansu_' ) && ! in_array( $key, array( 'mansu_hero_eyebrow', 'mansu_hero_title', 'mansu_hero_em', 'mansu_hero_lede' ), true ) && null === get_theme_mod( $key, null ) ) {
					set_theme_mod( $key, $value );
				}
			}
			foreach ( array( 'nav_menu_locations', 'custom_logo' ) as $key ) {
				if ( isset( $maison[ $key ] ) && ! get_theme_mod( $key ) ) {
					set_theme_mod( $key, $maison[ $key ] );
				}
			}
		}
		update_option( 'mansu_rose_mods_copied', 1 );
	}
);

/* Remove emoji scripts and styles: the theme never uses emoji. */
remove_action( 'wp_head', 'print_emoji_detection_script', 7 );
remove_action( 'wp_print_styles', 'print_emoji_styles' );
remove_action( 'admin_print_scripts', 'print_emoji_detection_script' );
remove_action( 'admin_print_styles', 'print_emoji_styles' );

/**
 * Menu fallback: New in, the featured categories and Contact.
 */
function mansu_menu_fallback() {
	$shop = function_exists( 'wc_get_page_permalink' ) ? wc_get_page_permalink( 'shop' ) : home_url( '/' );
	echo '<ul class="menu">';
	echo '<li><a href="' . esc_url( add_query_arg( 'orderby', 'date', $shop ) ) . '">' . esc_html__( 'New in', 'mansu-rose' ) . '</a></li>';
	foreach ( mansu_featured_cats() as $term ) {
		echo '<li><a href="' . esc_url( get_term_link( $term ) ) . '">' . esc_html( $term->name ) . '</a></li>';
	}
	echo '</ul>';
}
