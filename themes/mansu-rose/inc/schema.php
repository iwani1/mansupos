<?php
/**
 * Structured data the SEO plugin does not already provide.
 *
 * Rank Math (active on the live site) outputs Organization, WebSite + SearchAction,
 * breadcrumbs and Product schema. This theme only adds:
 *  - FAQPage on the home page, mirroring the visible FAQ;
 *  - ClothingStore (address, phone, area served) when no SEO plugin is active.
 *
 * @package Mansu_Rose
 */

defined( 'ABSPATH' ) || exit;

add_action(
	'wp_footer',
	function () {
		if ( ! is_front_page() ) {
			return;
		}
		$graph = array();

		$faq = mansu_faq_items();
		if ( $faq ) {
			$graph[] = array(
				'@type'      => 'FAQPage',
				'mainEntity' => array_map(
					function ( $qa ) {
						return array(
							'@type'          => 'Question',
							'name'           => $qa[0],
							'acceptedAnswer' => array( '@type' => 'Answer', 'text' => $qa[1] ),
						);
					},
					$faq
				),
			);
		}

		$seo_plugin = defined( 'RANK_MATH_VERSION' ) || defined( 'WPSEO_VERSION' ) || defined( 'AIOSEO_VERSION' );
		if ( ! $seo_plugin ) {
			$graph[] = array(
				'@type'      => 'ClothingStore',
				'@id'        => home_url( '/#store' ),
				'name'       => get_bloginfo( 'name' ),
				'url'        => home_url( '/' ),
				'telephone'  => '+' . mansu_wa_digits(),
				'email'      => mansu_opt( 'email' ),
				'address'    => array( '@type' => 'PostalAddress', 'streetAddress' => mansu_opt( 'address' ), 'addressCountry' => 'GH' ),
				'areaServed' => array( '@type' => 'Country', 'name' => 'Ghana' ),
			);
		}

		if ( $graph ) {
			echo '<script type="application/ld+json">' . wp_json_encode( array( '@context' => 'https://schema.org', '@graph' => $graph ), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) . "</script>\n";
		}
	}
);
