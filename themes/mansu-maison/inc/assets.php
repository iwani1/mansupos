<?php
/**
 * Styles, scripts, fonts and preloads.
 *
 * @package Mansu_Maison
 */

defined( 'ABSPATH' ) || exit;

add_action(
	'wp_enqueue_scripts',
	function () {
		$ver = MANSU_MAISON_VERSION;
		wp_enqueue_style( 'mansu-fonts', 'https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400..600;1,6..96,400..500&family=Jost:wght@400;500;600&display=swap', array(), null ); // phpcs:ignore WordPress.WP.EnqueuedResourceParameters.MissingVersion
		wp_enqueue_style( 'mansu-maison', get_stylesheet_uri(), array(), $ver );

		$deps = array();
		if ( class_exists( 'WooCommerce' ) ) {
			// Quick view renders the real add-to-cart form, so variation handling must be loaded wherever products are listed.
			wp_enqueue_script( 'wc-add-to-cart-variation' );
			wp_enqueue_script( 'wc-cart-fragments' );
			$deps = array( 'jquery', 'wc-add-to-cart-variation' );
		}
		wp_enqueue_script( 'mansu-maison', MANSU_MAISON_URI . '/assets/js/maison.js', $deps, $ver, array( 'in_footer' => true, 'strategy' => 'defer' ) );
		wp_localize_script(
			'mansu-maison',
			'MANSU',
			array(
				'ajax'    => class_exists( 'WC_AJAX' ) ? WC_AJAX::get_endpoint( '%%endpoint%%' ) : '',
				'search'  => home_url( '/' ),
				'cartUrl' => function_exists( 'wc_get_cart_url' ) ? wc_get_cart_url() : '',
				'i18n'    => array(
					'results'  => __( '%d results', 'mansu-maison' ),
					'result'   => __( '1 result', 'mansu-maison' ),
					'none'     => __( 'No match for “%s”. Try “dress”, “set” or a colour.', 'mansu-maison' ),
					'seeAll'   => __( 'See all results', 'mansu-maison' ),
					'added'    => __( 'Added to your bag', 'mansu-maison' ),
					'choose'   => __( 'Choose your options first.', 'mansu-maison' ),
					'error'    => __( 'That did not work. Open the product page to try again.', 'mansu-maison' ),
					'loading'  => __( 'Loading…', 'mansu-maison' ),
				),
			)
		);

		if ( is_singular() && comments_open() && get_option( 'thread_comments' ) ) {
			wp_enqueue_script( 'comment-reply' );
		}
	}
);

/* Connect to the font host early. */
add_filter(
	'wp_resource_hints',
	function ( $urls, $relation ) {
		if ( 'preconnect' === $relation ) {
			$urls[] = 'https://fonts.googleapis.com';
			$urls[] = array( 'href' => 'https://fonts.gstatic.com', 'crossorigin' );
		}
		return $urls;
	},
	10,
	2
);

/* On the home page, preload the first opening photo: it is the largest element in the first view. */
add_action(
	'wp_head',
	function () {
		if ( ! is_front_page() ) {
			return;
		}
		$id = absint( mansu_opt( 'hero_img1' ) );
		if ( $id ) {
			$src = wp_get_attachment_image_src( $id, 'woocommerce_single' );
			if ( $src ) {
				printf( '<link rel="preload" as="image" href="%s" fetchpriority="high">' . "\n", esc_url( $src[0] ) );
			}
		}
	},
	2
);
