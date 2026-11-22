<?php
/**
 * Styles, scripts, fonts and preloads.
 *
 * @package Mansu_Rose
 */

defined( 'ABSPATH' ) || exit;

add_action(
	'wp_enqueue_scripts',
	function () {
		$ver = MANSU_ROSE_VERSION;
		wp_enqueue_style( 'mansu-fonts', 'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;1,500&family=Inter:wght@400;500;600;700&display=swap', array(), null ); // phpcs:ignore WordPress.WP.EnqueuedResourceParameters.MissingVersion
		wp_enqueue_style( 'mansu-rose', get_stylesheet_uri(), array(), $ver );

		$deps = array();
		if ( class_exists( 'WooCommerce' ) ) {
			// Quick view renders the real add-to-cart form, so variation handling must be loaded wherever products are listed.
			wp_enqueue_script( 'wc-add-to-cart-variation' );
			wp_enqueue_script( 'wc-cart-fragments' );
			$deps = array( 'jquery', 'wc-add-to-cart-variation' );
		}
		wp_enqueue_script( 'mansu-rose', MANSU_ROSE_URI . '/assets/js/rose.js', $deps, $ver, array( 'in_footer' => true, 'strategy' => 'defer' ) );
		wp_localize_script(
			'mansu-rose',
			'MANSU',
			array(
				'ajax'    => class_exists( 'WC_AJAX' ) ? WC_AJAX::get_endpoint( '%%endpoint%%' ) : '',
				'search'  => home_url( '/' ),
				'cartUrl' => function_exists( 'wc_get_cart_url' ) ? wc_get_cart_url() : '',
				'i18n'    => array(
					'results'  => __( '%d results', 'mansu-rose' ),
					'result'   => __( '1 result', 'mansu-rose' ),
					'none'     => __( 'No match for “%s”. Try “dress”, “set” or a colour.', 'mansu-rose' ),
					'seeAll'   => __( 'See all results', 'mansu-rose' ),
					'added'    => __( 'Added to your bag', 'mansu-rose' ),
					'choose'   => __( 'Choose your options first.', 'mansu-rose' ),
					'error'    => __( 'That did not work. Open the product page to try again.', 'mansu-rose' ),
					'loading'  => __( 'Loading…', 'mansu-rose' ),
					'match1'   => __( '1 look matches', 'mansu-rose' ),
					'matchN'   => __( '%d looks match', 'mansu-rose' ),
					'show'     => __( 'Show %d looks', 'mansu-rose' ),
					'fewer'    => __( 'Try fewer answers', 'mansu-rose' ),
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
			$src = wp_get_attachment_image_src( $id, 'woocommerce_thumbnail' );
			if ( $src ) {
				printf( '<link rel="preload" as="image" href="%s" fetchpriority="high">' . "\n", esc_url( $src[0] ) );
			}
		}
	},
	2
);
