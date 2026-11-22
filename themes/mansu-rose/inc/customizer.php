<?php
/**
 * Customizer: everything the shop owner may want to change without code.
 * Appearance → Customize → Rosé.
 *
 * @package Mansu_Rose
 */

defined( 'ABSPATH' ) || exit;

/**
 * Default values for every setting.
 *
 * @return array<string, mixed>
 */
function mansu_defaults() {
	return array(
		'notice'         => "Delivery across Ghana\nShowroom in Accra\nWholesale & retail",
		'whatsapp'       => '+233 54 539 6555',
		'phone2'         => '+233 59 551 9150',
		'email'          => 'mansutrendzgh1@gmail.com',
		'address'        => 'Amu Wrist Ln 35, Accra, Ghana',
		'hero_eyebrow'   => 'Mansutrendzgh · Accra',
		'hero_title'     => 'Find your look',
		'hero_em'        => 'in three taps.',
		'hero_lede'      => "Tell us where you're going, your size and your budget. We'll show you the dresses, sets and tops that fit, from our Accra showroom to your door.",
		'finder_title'   => 'Style Finder',
		'finder_lede'    => 'Answer any or all. The count updates as you go.',
		'hero_img1'      => 0,
		'hero_img2'      => 0,
		'hero_img3'      => 0,
		'hero_link1'     => '',
		'hero_link2'     => '',
		'hero_link3'     => '',
		'hero_label1'    => 'Evening',
		'hero_label2'    => 'Dresses',
		'hero_label3'    => 'Office',
		'cats'           => 'dresses-womens-clothing, two-piece-sets, tops-blouses, pants-jeans, abayas-kaftans',
		'occ1_label'     => 'Office',
		'occ1_tag'       => 'office',
		'occ1_image'     => 0,
		'occ2_label'     => 'Church & events',
		'occ2_tag'       => 'church-events',
		'occ2_image'     => 0,
		'occ3_label'     => 'Evening',
		'occ3_tag'       => 'evening',
		'occ3_image'     => 0,
		'occ4_label'     => 'Weekend',
		'occ4_tag'       => 'casual',
		'occ4_image'     => 0,
		'hide_no_photo'  => true,
		'svc1_title'     => 'Delivered across Ghana',
		'svc1_text'      => 'Order online or on WhatsApp and we send it to you, from Accra to Kumasi to Tamale.',
		'svc2_title'     => 'Visit the showroom',
		'svc2_text'      => 'Try pieces on at Amu Wrist Ln 35, Accra, near Tudu Market.',
		'svc3_title'     => 'Wholesale for boutiques',
		'svc3_text'      => 'Stocking your own shop? Ask on WhatsApp for wholesale prices and pack sizes.',
		'faq'            => implode(
			"\n",
			array(
				'Do you deliver outside Accra? | Yes. We deliver across Ghana. Send your order and location on WhatsApp, or check out online, and we confirm the delivery cost for your area.',
				'Can I buy wholesale for my boutique? | Yes. Mansutrendzgh sells wholesale and retail. Message us on WhatsApp with the styles and quantities you want and we send wholesale prices.',
				'Where is your showroom? | Amu Wrist Ln 35, Accra, near Tudu Market. You can see and try current stock in person.',
				'How do I choose my size? | Each product lists the sizes we stock. If you are between sizes, ask us on WhatsApp for the garment measurements.',
				'How do I pay? | Add your pieces to the bag and check out on the website. Payment is by Paystack, and the delivery cost for your area is shown at checkout.',
			)
		),
	);
}

add_action(
	'customize_register',
	function ( WP_Customize_Manager $wp ) {
		$d = mansu_defaults();
		$wp->add_panel( 'mansu', array( 'title' => __( 'Rosé', 'mansu-rose' ), 'priority' => 30 ) );

		$text = function ( $section, $key, $label, $type = 'text', $desc = '' ) use ( $wp, $d ) {
			$wp->add_setting(
				'mansu_' . $key,
				array(
					'default'           => $d[ $key ],
					'sanitize_callback' => 'textarea' === $type ? 'sanitize_textarea_field' : 'sanitize_text_field',
				)
			);
			$wp->add_control( 'mansu_' . $key, array( 'section' => $section, 'label' => $label, 'type' => $type, 'description' => $desc ) );
		};
		$image = function ( $section, $key, $label ) use ( $wp ) {
			$wp->add_setting( 'mansu_' . $key, array( 'default' => 0, 'sanitize_callback' => 'absint' ) );
			$wp->add_control( new WP_Customize_Media_Control( $wp, 'mansu_' . $key, array( 'section' => $section, 'label' => $label, 'mime_type' => 'image' ) ) );
		};

		$wp->add_section( 'mansu_store', array( 'title' => __( 'Shop details', 'mansu-rose' ), 'panel' => 'mansu' ) );
		$text( 'mansu_store', 'notice', __( 'Top bar messages (one per line)', 'mansu-rose' ), 'textarea' );
		$text( 'mansu_store', 'whatsapp', __( 'WhatsApp number', 'mansu-rose' ), 'text', __( 'Used for "Order on WhatsApp" and "Ask on WhatsApp".', 'mansu-rose' ) );
		$text( 'mansu_store', 'phone2', __( 'Second phone number', 'mansu-rose' ) );
		$text( 'mansu_store', 'email', __( 'Email', 'mansu-rose' ) );
		$text( 'mansu_store', 'address', __( 'Showroom address', 'mansu-rose' ) );
		$wp->add_setting( 'mansu_hide_no_photo', array( 'default' => true, 'sanitize_callback' => 'wp_validate_boolean' ) );
		$wp->add_control(
			'mansu_hide_no_photo',
			array(
				'section'     => 'mansu_store',
				'type'        => 'checkbox',
				'label'       => __( 'Hide products without a photo from the shop and search', 'mansu-rose' ),
				'description' => __( 'They stay for sale and keep their own pages; they are only left out of lists.', 'mansu-rose' ),
			)
		);

		$wp->add_section( 'mansu_hero', array( 'title' => __( 'Home: opening', 'mansu-rose' ), 'panel' => 'mansu' ) );
		$text( 'mansu_hero', 'hero_eyebrow', __( 'Small line above the heading', 'mansu-rose' ) );
		$text( 'mansu_hero', 'hero_title', __( 'Heading', 'mansu-rose' ) );
		$text( 'mansu_hero', 'hero_em', __( 'Heading ending (rose italic)', 'mansu-rose' ) );
		$text( 'mansu_hero', 'hero_lede', __( 'Introduction', 'mansu-rose' ), 'textarea' );
		$text( 'mansu_hero', 'finder_title', __( 'Style Finder heading', 'mansu-rose' ) );
		$text( 'mansu_hero', 'finder_lede', __( 'Style Finder introduction', 'mansu-rose' ) );
		for ( $i = 1; $i <= 2; $i++ ) {
			/* translators: %d: image number */
			$image( 'mansu_hero', "hero_img{$i}", sprintf( __( 'Photo %d (portrait)', 'mansu-rose' ), $i ) );
			/* translators: %d: image number */
			$text( 'mansu_hero', "hero_label{$i}", sprintf( __( 'Photo %d label', 'mansu-rose' ), $i ) );
			/* translators: %d: image number */
			$text( 'mansu_hero', "hero_link{$i}", sprintf( __( 'Photo %d link', 'mansu-rose' ), $i ), 'url' );
		}

		$wp->add_section( 'mansu_cats', array( 'title' => __( 'Home: categories & occasions', 'mansu-rose' ), 'panel' => 'mansu' ) );
		$text( 'mansu_cats', 'cats', __( 'Category tiles (category slugs, comma separated)', 'mansu-rose' ), 'text', __( 'Also used for the shop category buttons and the menu, when no menu is set.', 'mansu-rose' ) );
		for ( $i = 1; $i <= 4; $i++ ) {
			/* translators: %d: occasion number */
			$text( 'mansu_cats', "occ{$i}_label", sprintf( __( 'Occasion %d name', 'mansu-rose' ), $i ) );
			/* translators: %d: occasion number */
			$text( 'mansu_cats', "occ{$i}_tag", sprintf( __( 'Occasion %d product tag slug', 'mansu-rose' ), $i ), 'text', __( 'Tag products with this tag to fill the occasion. Hidden while the tag has no products.', 'mansu-rose' ) );
			/* translators: %d: occasion number */
			$image( 'mansu_cats', "occ{$i}_image", sprintf( __( 'Occasion %d photo', 'mansu-rose' ), $i ) );
		}

		$wp->add_section( 'mansu_info', array( 'title' => __( 'Home: service & FAQ', 'mansu-rose' ), 'panel' => 'mansu' ) );
		for ( $i = 1; $i <= 3; $i++ ) {
			/* translators: %d: item number */
			$text( 'mansu_info', "svc{$i}_title", sprintf( __( 'Service %d title', 'mansu-rose' ), $i ) );
			/* translators: %d: item number */
			$text( 'mansu_info', "svc{$i}_text", sprintf( __( 'Service %d text', 'mansu-rose' ), $i ), 'textarea' );
		}
		$text( 'mansu_info', 'faq', __( 'FAQ (one per line: Question | Answer)', 'mansu-rose' ), 'textarea', __( 'Shown on the home page and published as FAQ structured data for Google.', 'mansu-rose' ) );
	}
);
